import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
const port = 5000;

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("BookNook API is Running!");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
