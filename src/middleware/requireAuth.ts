import { type Request, type Response, type NextFunction } from "express";
import { authService, type UserSession } from "../services/authService.js";

export interface AuthenticatedRequest extends Request {
  user?: UserSession;
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    return;
  }

  const token = authHeader.split(" ")[1];
  try {
    const user = authService.verifyToken(token);
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({
      error: "Unauthorized",
      message: error instanceof Error ? error.message : "Invalid token",
    });
  }
}
