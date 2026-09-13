import cron, {type ScheduledTask} from "node-cron";
import { randomUUID } from "node:crypto";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { aethex, isAethexConfigured } from "../lib/aethex.js";
import { workspaces } from "./workspaces.js";
import { db } from "./dbService.js";
let scheduledTask:ScheduledTask|null=null;
let isJobRunning=false;
let lastRunStats:CheckRemindersResult|null=null;
export interface CheckRemindersResult { checked:number;dispatched:number;durationMs:number;timestamp:string;skippedDueToConcurrency?:boolean;error?:string; }
export async function checkAndDispatchReminders():Promise<CheckRemindersResult> {
 const start=Date.now(),result:CheckRemindersResult={checked:0,dispatched:0,durationMs:0,timestamp:new Date().toISOString()};
 if(isJobRunning)return {...result,skippedDueToConcurrency:true};
 if(!isSupabaseConfigured()||!isAethexConfigured()||!process.env.AETHEX_FROM_NUMBER||!process.env.AETHEX_AGENT_ID)return result;
 isJobRunning=true;
 try {
  for(const {state} of await workspaces.all()) {
   const settings=state.settings.calls;if(!settings?.enabled)continue;
   for(const booking of state.bookings) {
    if(!["Confirmed","Pending","Needs confirmation","Rescheduled"].includes(booking.status))continue;
    const until=Date.parse(`${booking.startTime}+01:00`)-Date.now();
    if(until<=0||until>settings.reminderMinutes*60000)continue;
    result.checked++;
    const customer=state.customers.find(c=>c.id===booking.customerId),service=state.services.find(s=>s.id===booking.serviceId);if(!customer||!service)continue;
    const claim={business_id:state.business.id,booking_id:booking.id,appointment_time:booking.startTime};
    const {error}=await getSupabase().from("reminder_claims").insert(claim);
    if(error?.code==="23505")continue;
    if(error)throw new Error("Reminder storage is unavailable");
    // Keep the claim even if the provider response is ambiguous; never auto-redial after a timeout.
    try {
     const call=await aethex.triggerCall({toNumber:customer.phone,dynamicVariables:{business_name:state.business.name,customer_name:customer.name,service_name:service.name,appointment_date:booking.startTime.slice(0,10),appointment_time:booking.startTime.slice(11,16)},metadata:{business_id:state.business.id,booking_id:booking.id,call_type:"reminder"}});
     await db.createCall({id:randomUUID(),business_id:state.business.id,booking_id:booking.id,aethex_call_id:call.id,agent_id:call.agent_id,direction:call.direction,from_number:call.from_number,to_number:call.to_number,status:call.status,call_type:"reminder",created_at:call.created_at});result.dispatched++;
    }catch{console.error("Reminder dispatch needs review for reservation",booking.id);}
   }
  }
 }catch(error){result.error=error instanceof Error?error.message:"Reminder check failed";}
 finally{isJobRunning=false;result.durationMs=Date.now()-start;lastRunStats=result;}
 return result;
}
export function startCallScheduler(customCron?:string){
 if(process.env.ENABLE_CALL_SCHEDULER!=="true"||scheduledTask)return;
 const expression=customCron||process.env.CALL_REMINDER_CRON||"*/5 * * * *";
 if(!cron.validate(expression))throw new Error("Invalid CALL_REMINDER_CRON");
 scheduledTask=cron.schedule(expression,()=>{void checkAndDispatchReminders();});
}
export function stopCallScheduler(){scheduledTask?.stop();scheduledTask=null;}
export function getCallSchedulerStatus(){return {active:!!scheduledTask,cronPattern:process.env.CALL_REMINDER_CRON||"*/5 * * * *",isJobRunning,lastRunTimestamp:lastRunStats?.timestamp??null,lastRunStats};}
