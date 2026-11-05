import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import {
  jwtVerify,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importJWK,
} from "jose";
import "dotenv/config";

const JWKS_CACHE = new Map();
function getJWKS() {
  const authUrl = process.env.BETTER_AUTH_URL;
  if (!authUrl) {
    throw new Error("BETTER_AUTH_URL environment variable is missing.");
  }
  if (!JWKS_CACHE.has(authUrl)) {
    JWKS_CACHE.set(
      authUrl,
      createRemoteJWKSet(new URL(`${authUrl.replace(/\/$/, "")}/api/auth/jwks`)),
    );
  }
  return JWKS_CACHE.get(authUrl);
}

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(",").map((s) => s.trim().replace(/\/$/, ""))
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or Postman)
      if (!origin) return callback(null, true);

      // If CLIENT_URL is not set or wildcard, allow
      if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/$/, "");

      if (
        allowedOrigins.includes(normalizedOrigin) ||
        normalizedOrigin.startsWith("http://localhost:") ||
        normalizedOrigin.endsWith(".vercel.app")
      ) {
        return callback(null, true);
      }

      return callback(null, true);
    },
    credentials: true,
  }),
);
app.use(express.json());

// Database connection with serverless pooling & reconnection support
let client = null;
let db = null;
let booksCollection = null;
let borrowsCollection = null;

async function initDb() {
  if (db) return true;
  if (!process.env.MONGODB_URI) {
    console.warn("MONGODB_URI is not defined.");
    return false;
  }
  try {
    if (!client) {
      client = new MongoClient(process.env.MONGODB_URI);
    }
    await client.connect();
    db = client.db("book-nook");
    booksCollection = db.collection("books");
    borrowsCollection = db.collection("borrows");
    console.log("Successfully connected to MongoDB!");
    return true;
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    return false;
  }
}

// Attempt initial connection eagerly if URI is present
if (process.env.MONGODB_URI) {
  initDb().catch((err) => console.error("Initial DB connection attempt:", err.message));
}

// Health check endpoint
app.get("/", (req, res) => {
  res.send("BookNook API is Running!");
});

// Middleware to ensure DB is connected before handling data endpoints
app.use(async (req, res, next) => {
  if (req.path === "/") return next();
  const connected = await initDb();
  if (!connected) {
    return res.status(500).send({
      success: false,
      message: "Database connection failed. Please check MONGODB_URI.",
    });
  }
  next();
});

const verifyBookId = (req, res, next) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({
      success: false,
      message: "Invalid book ID.",
    });
  }

  next();
};

// Verify a BetterAuth JWT against the signing key it stores in the shared
// `jwks` collection. BetterAuth mints an asymmetric key pair in the database
// (BETTER_AUTH_SECRET never signs these tokens), so reading the public key
// straight from the database this server already connects to removes the
// dependency on fetching `${BETTER_AUTH_URL}/api/auth/jwks` over the network.
async function verifyWithDatabaseKey(token) {
  if (!db) return null;

  const header = decodeProtectedHeader(token);
  if (!header?.kid) return null;

  const jwks = db.collection("jwks");

  // The adapter stores ids in `_id` (an ObjectId) and exposes them as `id`.
  let keyDoc = null;
  if (ObjectId.isValid(header.kid)) {
    keyDoc = await jwks.findOne({ _id: new ObjectId(header.kid) });
  }
  if (!keyDoc) {
    keyDoc = await jwks.findOne({ _id: header.kid });
  }
  if (!keyDoc) {
    keyDoc = await jwks.findOne({ id: header.kid });
  }
  if (!keyDoc?.publicKey) return null;

  try {
    const alg = keyDoc.alg || header.alg;
    if (!alg) return null;

    const publicJwk = {
      ...JSON.parse(keyDoc.publicKey),
      alg,
      kid: header.kid,
    };
    const key = await importJWK(publicJwk, alg);
    const { payload } = await jwtVerify(token, key);
    return payload;
  } catch (error) {
    console.warn("Database JWKS verification attempt failed:", error.message);
    return null;
  }
}

// Middleware: validate JWT session and attach user to req
async function authenticateJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).send({
        success: false,
        message: "Authentication required.",
      });
    }

    const token = authHeader.split(" ")[1];

    let payload = null;
    let verified = false;

    // 1. Try the signing key stored in the shared `jwks` collection
    try {
      payload = await verifyWithDatabaseKey(token);
      verified = Boolean(payload);
    } catch (dbKeyErr) {
      console.warn("Database JWKS verification attempt failed:", dbKeyErr.message);
    }

    // 2. Try remote JWKS if BETTER_AUTH_URL is provided
    if (!verified && process.env.BETTER_AUTH_URL) {
      try {
        const jwks = getJWKS();
        const result = await jwtVerify(token, jwks);
        payload = result.payload;
        verified = true;
      } catch (jwksErr) {
        console.warn("JWKS verification attempt failed:", jwksErr.message);
      }
    }

    // 3. Fallback to BETTER_AUTH_SECRET if available
    if (!verified && process.env.BETTER_AUTH_SECRET) {
      try {
        const secret = new TextEncoder().encode(process.env.BETTER_AUTH_SECRET);
        const result = await jwtVerify(token, secret);
        payload = result.payload;
        verified = true;
      } catch (secretErr) {
        console.warn("Secret verification attempt failed:", secretErr.message);
      }
    }

    if (!verified || !payload) {
      return res.status(401).send({
        success: false,
        message: "Invalid or expired token.",
      });
    }

    req.user = payload;

    next();
  } catch (error) {
    console.error("JWT verification error:", error.message);

    return res.status(401).send({
      success: false,
      message: "Invalid or expired token.",
    });
  }
}

// Helper: check if user owns a book
async function checkBookOwnership(bookId, userEmail) {
  const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });
  if (!book) return null;
  if (book.userEmail !== userEmail) return null;
  return book;
}

// 1. GET /books — get all books (public)
app.get("/books", async (req, res) => {
  try {
    const sort = req.query.sort;
    const limit = req.query.limit ? parseInt(req.query.limit) : 0;
    const userEmail = req.query.userEmail;

    const filter = {};
    if (userEmail) {
      filter.userEmail = userEmail;
    }

    let cursor = booksCollection.find(filter);

    if (sort) {
      const [field, order] = sort.split(":");
      cursor = cursor.sort({ [field]: order === "desc" ? -1 : 1 });
    }

    if (limit > 0) {
      cursor = cursor.limit(limit);
    }

    const books = await cursor.toArray();

    res.send(books);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch books.",
    });
  }
});

// 2. GET /books/:id — get one book (public)

app.get("/books/:id", verifyBookId, async (req, res) => {
  try {
    const book = await booksCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!book) {
      return res.status(404).send({
        success: false,
        message: "Book not found.",
      });
    }

    res.send(book);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch book.",
    });
  }
});

// 3. POST /books — add a book (public — user info comes from body)
app.post("/books", authenticateJWT, async (req, res) => {
  try {
    const { title, author, category, description, totalCopies, image } =
      req.body;

    const userEmail = req.user.email;
    const userName = req.user.name;

    const newBook = {
      title,
      author,
      category,
      description,
      totalCopies,
      availableCopies: totalCopies,
      image,
      userName,
      userEmail,
      createdAt: new Date(),
    };

    const result = await booksCollection.insertOne(newBook);

    res.status(201).send({
      success: true,
      message: "Book added successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Add book error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to add book.",
    });
  }
});

// 4. PATCH /books/:id — update a book (protected, owner only)
app.patch("/books/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const userEmail = req.user?.email;

    const book = await checkBookOwnership(id, userEmail);
    if (!book) {
      return res.status(404).send({
        success: false,
        message: "Book not found or you do not own this book.",
      });
    }

    const allowedFields = [
      "title",
      "author",
      "category",
      "description",
      "image",
      "totalCopies",
      "availableCopies",
    ];
    const setFields = {};

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        if (field === "totalCopies" || field === "availableCopies") {
          setFields[field] = Number(updates[field]);
        } else {
          setFields[field] = updates[field];
        }
      }
    }

    if (Object.keys(setFields).length === 0) {
      return res.status(400).send({
        success: false,
        message: "No valid fields to update.",
      });
    }

    await booksCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: setFields },
    );

    const updated = await booksCollection.findOne({ _id: new ObjectId(id) });

    res.send({
      success: true,
      message: "Book updated successfully!",
      book: updated,
    });
  } catch (error) {
    console.error("Update book error:", error);
    res.status(500).send({
      success: false,
      message: "Failed to update book.",
    });
  }
});

// 5. DELETE /books/:id — delete a book (protected, owner only)
app.delete("/books/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user?.email;

    const book = await checkBookOwnership(id, userEmail);
    if (!book) {
      return res.status(404).send({
        success: false,
        message: "Book not found or you do not own this book.",
      });
    }

    await booksCollection.deleteOne({
      _id: new ObjectId(id),
    });

    res.send({
      success: true,
      message: "Book deleted successfully!",
    });
  } catch (error) {
    console.error("Delete book error:", error);
    res.status(500).send({
      success: false,
      message: "Failed to delete book.",
    });
  }
});

// 6. POST /borrows — borrow a book (protected)
app.post("/borrows", authenticateJWT, async (req, res) => {
  try {
    const { bookId, bookTitle, bookImage } = req.body;

    // Get authenticated user information from JWT
    const userEmail = req.user.email;
    const userId = req.user.id;
    const userName = req.user.name;

    if (!bookId || !ObjectId.isValid(bookId)) {
      return res.status(400).send({
        success: false,
        message: "Valid bookId is required.",
      });
    }

    if (!userEmail) {
      return res.status(401).send({
        success: false,
        message: "User authentication failed.",
      });
    }

    // Find book
    const book = await booksCollection.findOne({
      _id: new ObjectId(bookId),
    });

    if (!book) {
      return res.status(404).send({
        success: false,
        message: "Book not found.",
      });
    }

    // Check available copies
    const availableCopies = Math.max(
      0,
      book.availableCopies ?? book.totalCopies ?? 1,
    );

    if (availableCopies <= 0) {
      return res.status(400).send({
        success: false,
        message: "Book is not available for borrowing.",
        code: "NOT_AVAILABLE",
      });
    }

    // Prevent duplicate active borrowing
    const existingBorrow = await borrowsCollection.findOne({
      bookId,
      userEmail,
      status: "borrowed",
    });

    if (existingBorrow) {
      return res.status(400).send({
        success: false,
        message: "You have already borrowed this book.",
        code: "ALREADY_BORROWED",
      });
    }

    // Create borrow record
    const borrowRecord = {
      bookId,
      bookTitle: bookTitle ?? book.title,
      bookImage: bookImage ?? book.image,
      userId,
      userName: userName ?? "Reader",
      userEmail,
      borrowDate: new Date(),
      returnDate: null,
      status: "borrowed",
      createdAt: new Date(),
    };

    // Insert borrow record
    const borrowResult = await borrowsCollection.insertOne(borrowRecord);

    // Decrease available copies
    await booksCollection.updateOne(
      {
        _id: new ObjectId(bookId),
        availableCopies: { $gt: 0 },
      },
      {
        $inc: { availableCopies: -1 },
      },
    );

    res.status(201).send({
      success: true,
      message: "Book borrowed successfully!",
      borrowId: borrowResult.insertedId,
    });
  } catch (error) {
    console.error("Borrow book error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to borrow book.",
    });
  }
});

// 7. GET /borrows — get borrows of the logged in user (protected)
app.get("/borrows", authenticateJWT, async (req, res) => {
  try {
    const userEmail = req.user.email;

    const borrows = await borrowsCollection.find({ userEmail }).toArray();

    res.send(borrows);
  } catch (error) {
    console.error("Fetch borrows error:", error);

    res.status(500).send({
      message: "Failed to fetch borrows.",
    });
  }
});

// 8. DELETE /borrows/:id — return a book (protected)
app.delete("/borrows/:id", authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;

    // Try to find by borrow record _id first, then fall back to bookId
    let borrow;
    try {
      borrow = await borrowsCollection.findOne({ _id: new ObjectId(id) });
    } catch {}
    if (!borrow) {
      borrow = await borrowsCollection.findOne({
        bookId: id,
        status: "borrowed",
      });
    }

    if (!borrow) {
      return res.status(404).send({
        success: false,
        message: "Borrow record not found.",
      });
    }

    if (borrow.status === "returned") {
      return res.status(400).send({
        success: false,
        message: "Book already returned.",
      });
    }

    await borrowsCollection.updateOne(
      { _id: borrow._id },
      {
        $set: {
          status: "returned",
          returnDate: new Date(),
        },
      },
    );

    const book = await booksCollection.findOne({
      _id: new ObjectId(borrow.bookId),
    });

    if (book) {
      // Increase copies atomically with $inc
      await booksCollection.updateOne(
        { _id: new ObjectId(borrow.bookId) },
        { $inc: { availableCopies: 1 } },
      );
    }

    res.send({
      success: true,
      message: "Book returned successfully!",
    });
  } catch (error) {
    console.error("Return book error:", error);
    res.status(500).send({
      success: false,
      message: "Failed to return book.",
    });
  }
});

export default app;

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}
