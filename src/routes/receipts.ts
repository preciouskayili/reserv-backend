import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireWorkspace, type WorkspaceRequest } from "../middleware/requireWorkspace.js";
import { workspaces, publicState } from "../services/workspaces.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { HttpError } from "../domain/workspace.js";
const router=Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1,fields:1}});
router.post("/reservation/:code",rateLimit({windowMs:60000,limit:10,standardHeaders:true,legacyHeaders:false}),upload.single("file"),async(req,res)=>{
 const code=String(req.params.code), snapshot=await workspaces.byCode(code), booking=snapshot.state.bookings.find(b=>b.code===code)!;
 if(!isSupabaseConfigured())throw new HttpError(503,"Receipt storage is unavailable");
 if(["Cancelled","Completed"].includes(booking.status))throw new HttpError(409,"This reservation cannot accept payments");
 const payments=snapshot.state.payments??[], records=payments.filter(p=>p.bookingId===booking.id),paid=records.filter(p=>p.status==="approved"&&!p.disputed).reduce((n,p)=>n+Math.max(0,p.amount-(p.refundedAmount??0)),0),amount=Number(req.body.amount);
 if(records.some(p=>p.status==="review")||!Number.isFinite(amount)||amount<=0||amount<(booking.requiredAmount??0)-paid||amount>(booking.totalAmount??0)-paid)throw new HttpError(400,"Check the payment amount or existing receipt review");
 const file=req.file;if(!file||!file.size)throw new HttpError(400,"Choose a receipt file");
 const signatures:Record<string,boolean>={"application/pdf":file.buffer.subarray(0,5).toString()==="%PDF-","image/jpeg":file.buffer[0]===255&&file.buffer[1]===216&&file.buffer[2]===255,"image/png":file.buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),"image/webp":file.buffer.subarray(0,4).toString()==="RIFF"&&file.buffer.subarray(8,12).toString()==="WEBP"};
 if(!signatures[file.mimetype])throw new HttpError(400,"Choose a valid JPG, PNG, WebP, or PDF receipt");
 const id=randomUUID(),key=`${snapshot.state.business.id}/${id}`,storage=getSupabase().storage.from("receipts");
 const {error}=await storage.upload(key,file.buffer,{contentType:file.mimetype,upsert:false});if(error)throw new HttpError(503,"Couldn’t upload the receipt. Please try again.");
 snapshot.state.payments=[...payments,{id,bookingId:booking.id,amount,method:"transfer",status:"review",receiptId:id,receiptName:file.originalname.slice(0,200),createdAt:new Date().toISOString()}];
 booking.activity.push({id,title:"Receipt submitted for review",time:new Date().toISOString(),actor:"customer"});
 try {const result=await workspaces.save(snapshot.state.business.id,snapshot.revision,snapshot.state);res.status(201).json(publicState(result,code));}
 catch(error){await storage.remove([key]);throw error;}
});
router.get("/:id",requireAuth,requireWorkspace,async(req:WorkspaceRequest,res)=>{
 const {state}=await workspaces.read(req.workspaceId!);const id=String(req.params.id);
 if(!state.payments?.some(p=>p.receiptId===id))throw new HttpError(404,"Receipt not found");
 const {data,error}=await getSupabase().storage.from("receipts").createSignedUrl(`${req.workspaceId}/${id}`,60);
 if(error)throw new HttpError(503,"Couldn’t open this receipt. Please try again.");res.json({url:data.signedUrl});
});
export default router;
