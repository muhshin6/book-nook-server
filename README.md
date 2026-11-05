# BookNook Server

Express 5 + MongoDB REST API for **BookNook**, a community book-sharing platform. The server stores the shared book shelf, validates BetterAuth JWTs, and manages borrowing and returning books.

## Features

- **Book catalog** — list all books with optional sorting (`sort=createdAt:desc`), limiting (`limit=10`), and owner filtering (`userEmail=...`).
- **Book details** — fetch a single book by its MongoDB `_id`, with id validation.
- **Add books** — authenticated users add a book with title, author, category, description, cover image, and total copies. Owner name and email come from the verified JWT.
- **Edit and delete books** — owner-only updates and deletes, enforced by matching the JWT email against `userEmail`.
- **Borrow books** — authenticated borrowing with availability checks (`NOT_AVAILABLE`) and duplicate-borrow protection (`ALREADY_BORROWED`). Decrements `availableCopies` atomically with `$inc`.
- **Return books** — marks a borrow as `returned`, records `returnDate`, and increments `availableCopies` atomically.
- **JWT authentication** — verifies BetterAuth-issued tokens with `jose` and a remote JWKS endpoint. Protected routes accept `Authorization: Bearer <token>`.
- **Health check** — `GET /` confirms the API is running.

## Tech Stack

- Node.js 18+ (ES modules)
- Express 5
- MongoDB (official `mongodb` driver v7)
- `jose` for JWT verification via JWKS
- `cors` and `dotenv`

## Getting Started

### Prerequisites

- Node.js 18+
- A MongoDB database (local or Atlas)
- A running BookNook client / BetterAuth instance that exposes `/api/auth/jwks`

### Install

```bash
npm install
```

### Environment

Create a `.env` file in the project root:

```
MONGODB_URI=mongodb://localhost:27017/book-nook
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=your_better_auth_secret
CLIENT_URL=http://localhost:3000
```

| Variable | Purpose |
|----------|---------|
| `MONGODB_URI` | MongoDB connection string. The server uses the `book-nook` database. |
| `BETTER_AUTH_URL` | Base URL of the BetterAuth server; JWKS is read from `/api/auth/jwks`. |
| `BETTER_AUTH_SECRET` | BetterAuth secret used by the auth stack. |
| `CLIENT_URL` | Allowed CORS origin for the client app. |

### Run

```bash
npm run dev
```

The API listens on **http://localhost:5000**. `npm run dev` uses `node --watch`, so the server restarts on file changes.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start the server with `node --watch` on port 5000 |
| `npm start` | Start the server with plain `node` |
| `npm test` | Placeholder test script (no test runner configured) |

## API Reference

Base URL: `http://localhost:5000`

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/` | Public | Health check; returns `BookNook API is Running!` |
| `GET` | `/books` | Public | List books. Supports `sort=<field>:<asc\|desc>`, `limit=<n>`, and `userEmail=<email>`. |
| `GET` | `/books/:id` | Public | Get one book by MongoDB `_id`. Returns `400` for an invalid id, `404` if missing. |
| `POST` | `/books` | JWT | Add a book. Persists owner `userName`/`userEmail`, `createdAt`, `totalCopies`, and `availableCopies`. |
| `PATCH` | `/books/:id` | JWT, owner | Partially update allowed book fields. |
| `DELETE` | `/books/:id` | JWT, owner | Delete a book owned by the authenticated user. |
| `POST` | `/borrows` | JWT | Borrow a book. Decrements `availableCopies`; rejects unavailable or duplicate borrows. |
| `GET` | `/borrows` | JWT | List the authenticated user's borrow records. |
| `DELETE` | `/borrows/:id` | JWT | Return a book by borrow record `_id` (falls back to `bookId`). Increments `availableCopies`. |

### Authentication

Protected routes require a BetterAuth JWT:

```
Authorization: Bearer <token>
```

`authenticateJWT` verifies the token against the JWKS endpoint built from `BETTER_AUTH_URL`, then attaches the payload to `req.user`. Book update/delete additionally check that `book.userEmail` matches `req.user.email`.

## Project Structure

```
index.js          # Express app: middleware, auth, and all routes
package.json      # Scripts and dependencies
vercel.json       # Vercel deployment configuration
```

The server connects to MongoDB on startup, then serves the `books` and `borrows` collections from the `book-nook` database.

## Deployment

The project deploys to Vercel as a zero-config Express app. `vercel.json` pins the function region to Singapore (`sin1`). `index.js` exports the Express app for Vercel and only calls `app.listen` outside Vercel (`process.env.VERCEL !== "1"`), so the same entry point works locally and in serverless.

Configure `MONGODB_URI`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and `CLIENT_URL` in the Vercel project settings. Set `CLIENT_URL` to the deployed client origin so CORS accepts browser requests.

## Related Repository

The Next.js client lives in the sibling repo `../book-nook-client`.
