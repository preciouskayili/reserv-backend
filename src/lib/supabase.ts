import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseConfigured = (): boolean => {
  return Boolean(supabaseUrl && supabaseKey);
};

let clientInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    console.warn(
      "[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured in .env. Operating in fallback mode."
    );
  }

  if (!clientInstance) {
    clientInstance = createClient(
      supabaseUrl || "https://placeholder-project.supabase.co",
      supabaseKey || "placeholder-key",
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );
  }

  return clientInstance;
}

export const supabase = getSupabase();
