import { Router } from "express";
import multer from "multer";
import cloudinary from "../lib/cloudinary.js";

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

router.post("/", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }

  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(base64, {
      folder: "reserv",
    });
    res.json({ url: result.secure_url, publicId: result.public_id });
  } catch (err) {
    res.status(500).json({ error: "Upload failed" });
  }
});

export default router;
