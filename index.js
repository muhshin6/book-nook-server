import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { jwtVerify, createRemoteJWKSet } from "jose";
import "dotenv/config";

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.BETTER_AUTH_URL}/api/auth/jwks`),
);

const app = express();
const port = 5000;

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);

app.get("/", (req, res) => {
  res.send("BookNook API is Running!");
});

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Successfully connected to MongoDB!");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  }
}

await connectToMongoDB();

const db = client.db("book-nook");
const booksCollection = db.collection("books");
const borrowsCollection = db.collection("borrows");

const verifyBookId = (req, res, next) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({
      success: false,
      message: "Invalid book ID.",
    });
  }

  next();
};

// JWT secret for session validation
const JWT_SECRET = new TextEncoder().encode(process.env.BETTER_AUTH_SECRET);

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

    const { payload } = await jwtVerify(token, JWKS);

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
    const books = await booksCollection.find({}).toArray();

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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
