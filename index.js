import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
