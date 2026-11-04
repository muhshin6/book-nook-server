import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
