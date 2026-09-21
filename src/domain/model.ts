export type BookingStatus =
  | "Confirmed"
  | "Pending"
  | "Needs confirmation"
  | "Cancelled"
  | "Completed"
  | "Rescheduled";
export interface StaffMember {
  avatarUrl?: string;
  id: string;
  name: string;
  role: string;
  initials: string;
}
export interface Service {
  id: string;
  name: string;
  description: string;
  duration: number;
  price: number;
  deposit: number;
  staffIds: string[];
  active: boolean;
}
export interface Customer {
  id: string;
  name: string;
  phone: string;
  notes: string;
}
export interface BookingActivity {
  id: string;
  title: string;
  detail?: string;
  time: string;
  actor: "owner" | "customer" | "agent";
}
export interface Booking {
  id: string;
  code: string;
  businessId: string;
  customerId: string;
  serviceId: string;
  staffId: string;
  startTime: string;
  endTime: string;
  status: BookingStatus;
  notes: string;
  createdAt: string;
  reminder?: string;
  totalAmount?: number;
  requiredAmount?: number;
  activity: BookingActivity[];
}
export interface BusinessHours {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}
export interface AvailabilityRule {
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  slotMinutes: number;
}
export interface Business {
  logoUrl?: string;
  icon?: "store" | "flower" | "scissors" | "sparkles";
  id: string;
  name: string;
  slug: string;
  owner: string;
  category: string;
  description: string;
  phone: string;
  address: string;
  hours: BusinessHours[];
  bookingPolicy: string;
  cancellationPolicy: string;
  depositPolicy: string;
  faqs: { question: string; answer: string }[];
  rules: AvailabilityRule;
}
export interface AgentActivity {
  id: string;
  title: string;
  detail: string;
  time: string;
  kind: "confirmed" | "rescheduled" | "created";
}
export interface CallPreferences {
  enabled: boolean;
  reminderMinutes: number;
  unpaidEnabled: boolean;
  unpaidIntervalMinutes: number;
}
export const DEFAULT_CALL_PREFERENCES: CallPreferences = {
  enabled: false,
  reminderMinutes: 120,
  unpaidEnabled: false,
  unpaidIntervalMinutes: 1440,
};
export interface Payment {
  provider?: "paystack" | "stripe";
  reference?: string;
  needsReview?: boolean;
  refundedAmount?: number;
  disputed?: boolean;
  id: string;
  bookingId: string;
  amount: number;
  method: "gateway" | "transfer";
  status: "review" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string;
  rejectionReason?: string;
  receiptId?: string;
  receiptName?: string;
}
export interface AppState {
  business: Business;
  services: Service[];
  staff: StaffMember[];
  customers: Customer[];
  bookings: Booking[];
  payments?: Payment[];
  agentActivity: AgentActivity[];
  settings: {
    reminders: boolean;
    confirmations: boolean;
    owner: string;
    ownerStaffId?: string;
    calls?: CallPreferences;
  };
  loaded: boolean;
}
