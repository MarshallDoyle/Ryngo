// Exercises: Express-style route registration, middleware chain, handler edges.
// The route literal "/users/:id" is the http-route target leaf.

import type { Request, Response, NextFunction } from "express";

type Handler = (req: Request, res: Response) => void;
type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const app = {
  get(_path: string, ..._chain: (Handler | Middleware)[]): void {},
  post(_path: string, ..._chain: (Handler | Middleware)[]): void {},
};

function auth(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

function validate(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

function getUser(req: Request, res: Response): void {
  const id = req.params.id;
  res.json({ id });
}

function createUser(req: Request, res: Response): void {
  const body = req.body;
  res.json({ created: true, body });
}

app.get("/users/:id", auth, getUser);
app.post("/users", auth, validate, createUser);
