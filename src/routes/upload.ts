import {
  requireWorkspace,
  type WorkspaceRequest,
} from "../middleware/requireWorkspace.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/requireAuth.js";
import { Router } from "express";
import multer from "multer";
import cloudinary from "../lib/cloudinary.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (
      ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
        file.mimetype,
      )
    )
      callback(null, true);
    else callback(new Error("Choose a JPG, PNG, WebP, or PDF file."));
  },
});

const router = Router();

// Authenticated before a workspace exists, so onboarding can upload its images.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
router.post("/image", requireAuth, imageUpload.single("file"), async (req: AuthenticatedRequest, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Choose a photo to upload." });
  const bytes = file.buffer;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!(jpeg || png || webp)) return res.status(400).json({ error: "Choose a JPG, PNG, or WebP image." });
  if (!["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"].every(key => process.env[key]))
    return res.status(503).json({ error: "Image uploads are not configured yet." });
  try {
    const type = jpeg ? "jpeg" : png ? "png" : "webp";
    const result = await cloudinary.uploader.upload(`data:image/${type};base64,${bytes.toString("base64")}`, {
      folder: `reserv/profiles/${req.user!.id}`,
      resource_type: "image", format: "webp",
      transformation: [{ width: 512, height: 512, crop: "limit" }, { quality: "auto" }],
    });
    return res.status(201).json({ url: result.secure_url });
  } catch {
    return res.status(502).json({ error: "Your image could not be uploaded. Please try again." });
  }
});

router.post(
  "/",
  requireAuth,
  requireWorkspace,
  upload.single("file"),
  async (req: WorkspaceRequest, res) => {
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
  },
);

export default router;
