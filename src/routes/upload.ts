import { requireWorkspace, type WorkspaceRequest } from "../middleware/requireWorkspace.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { Router } from "express";
import multer from "multer";
import cloudinary from "../lib/cloudinary.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype)) callback(null, true);
    else callback(new Error("Choose a JPG, PNG, WebP, or PDF file."));
  },
});

const router = Router();

router.post("/", requireAuth, requireWorkspace, upload.single("file"), async (req: WorkspaceRequest, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }

  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(base64, {
      folder: `reserv/${req.workspaceId}`,
    });
    res.json({ url: result.secure_url, publicId: result.public_id });
  } catch (err) {
    res.status(500).json({ error: "Upload failed" });
  }
});

export default router;
