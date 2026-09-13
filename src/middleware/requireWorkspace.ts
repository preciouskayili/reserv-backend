import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./requireAuth.js";
import { workspaces } from "../services/workspaces.js";
import { HttpError } from "../domain/workspace.js";
export interface WorkspaceRequest extends AuthenticatedRequest { workspaceId?: string }
export async function requireWorkspace(req: WorkspaceRequest, _res: Response, next: NextFunction) {
  try {
    const id = req.header("x-workspace-id");
    if (!req.user) throw new HttpError(401, "Sign in to continue");
    if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "Choose a workspace first");
    await workspaces.authorize(req.user.id,id,req.method !== "GET"); req.workspaceId=id; next();
  } catch(error) { next(error); }
}
