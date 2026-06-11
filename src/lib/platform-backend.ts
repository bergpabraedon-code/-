import { createClient } from "@supabase/supabase-js";

export type PlatformConfig = {
  pointsPerGeneration: number;
  signupBonusPoints: number;
  serviceName: string;
  serviceStatus: string;
  upstreamChannelLabel: string;
  upstreamProtocol: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  upstreamDefaultModel: string;
  upstreamAnalysisModel: string;
};

export type PlatformSessionUser = {
  id: string;
  email: string;
  points: number;
  createdAt: number;
  isAdmin: boolean;
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || "";
const SUPABASE_BROWSER_PROXY_PATH = "/api/supabase";
const SETTINGS_ROW_ID = "default";
const SUPABASE_DEMO_SESSION_STORAGE_KEY = "imageStudioSupabaseDemoSession";

export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  pointsPerGeneration: 12,
  signupBonusPoints: 120,
  serviceName: "ai图片精灵",
  serviceStatus: "统一账号登录后使用，平台已托管固定生图 API。",
  upstreamChannelLabel: "banana Pro 官转",
  upstreamProtocol: "custom-openai",
  upstreamBaseUrl: "",
  upstreamApiKey: "",
  upstreamDefaultModel: "gpt-image-2",
  upstreamAnalysisModel: "gpt-5.4",
};

export const isSupabaseEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

function resolveBrowserSupabaseUrl() {
  if (typeof window === "undefined") return SUPABASE_URL;
  return `${window.location.origin}${SUPABASE_BROWSER_PROXY_PATH}`;
}

export const supabase = isSupabaseEnabled
  ? createClient(resolveBrowserSupabaseUrl(), SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  : null;

function normalizeConfigRow(row: Partial<{
  points_per_generation: number | null;
  signup_bonus_points: number | null;
  service_name: string | null;
  service_status: string | null;
  upstream_channel_label: string | null;
  upstream_protocol: string | null;
  upstream_base_url: string | null;
  upstream_api_key: string | null;
  upstream_default_model: string | null;
  upstream_analysis_model: string | null;
}> | null | undefined): PlatformConfig {
  return {
    pointsPerGeneration: Math.max(
      1,
      Number(row?.points_per_generation) || DEFAULT_PLATFORM_CONFIG.pointsPerGeneration,
    ),
    signupBonusPoints: Math.max(
      0,
      Number(row?.signup_bonus_points) || DEFAULT_PLATFORM_CONFIG.signupBonusPoints,
    ),
    serviceName: row?.service_name?.trim() || DEFAULT_PLATFORM_CONFIG.serviceName,
    serviceStatus: row?.service_status?.trim() || DEFAULT_PLATFORM_CONFIG.serviceStatus,
    upstreamChannelLabel: row?.upstream_channel_label?.trim() || DEFAULT_PLATFORM_CONFIG.upstreamChannelLabel,
    upstreamProtocol: row?.upstream_protocol?.trim() || DEFAULT_PLATFORM_CONFIG.upstreamProtocol,
    upstreamBaseUrl: row?.upstream_base_url?.trim() || DEFAULT_PLATFORM_CONFIG.upstreamBaseUrl,
    upstreamApiKey: row?.upstream_api_key?.trim() || DEFAULT_PLATFORM_CONFIG.upstreamApiKey,
    upstreamDefaultModel: row?.upstream_default_model?.trim() || DEFAULT_PLATFORM_CONFIG.upstreamDefaultModel,
    upstreamAnalysisModel: row?.upstream_analysis_model?.trim() || DEFAULT_PLATFORM_CONFIG.upstreamAnalysisModel,
  };
}

function toEpoch(value: string | null | undefined) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizeUserRow(
  profile: Partial<{
    id: string;
    email: string | null;
    created_at: string | null;
    is_admin: boolean | null;
  }>,
  points: number,
  emailFallback = "",
): PlatformSessionUser {
  return {
    id: profile.id || "",
    email: profile.email?.trim() || emailFallback,
    points: Math.max(0, Number(points) || 0),
    createdAt: toEpoch(profile.created_at),
    isAdmin: Boolean(profile.is_admin),
  };
}

function isMissingEnsurePlatformUserRpcError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown; details?: unknown };
  const detailText = `${String(maybeError.message || "")} ${String(maybeError.details || "")}`;
  return maybeError.code === "PGRST202" && detailText.includes("ensure_platform_user");
}

function isMissingPlatformSchemaError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { code?: unknown; message?: unknown; details?: unknown };
  const detailText = `${String(maybeError.message || "")} ${String(maybeError.details || "")}`;
  return (
    maybeError.code === "PGRST205"
    || (
      maybeError.code === "PGRST202"
      && (
        detailText.includes("ensure_platform_user")
        || detailText.includes("consume_generation_points")
        || detailText.includes("refund_generation_points")
        || detailText.includes("admin_adjust_points")
      )
    )
  );
}

function sessionUserFallback(user: { id?: string; email?: string | null } | null | undefined, emailFallback = "") {
  const email = user?.email?.trim() || emailFallback.trim();
  if (!user?.id || !email) return null;
  return normalizeUserRow(
    {
      id: user.id,
      email,
      created_at: new Date().toISOString(),
      is_admin: email.toLowerCase() === "461059476@qq.com",
    },
    DEFAULT_PLATFORM_CONFIG.signupBonusPoints,
    email,
  );
}

export function getSupabaseMissingConfigMessage() {
  if (isSupabaseEnabled) return "";
  return "未配置 Supabase，当前仍使用本地演示数据。";
}

export async function fetchPlatformConfig() {
  if (!supabase) return DEFAULT_PLATFORM_CONFIG;
  const { data, error } = await supabase
    .from("app_settings")
    .select("service_name, service_status, points_per_generation, signup_bonus_points, upstream_channel_label, upstream_protocol, upstream_default_model, upstream_analysis_model")
    .eq("id", SETTINGS_ROW_ID)
    .maybeSingle();
  if (error || !data) return DEFAULT_PLATFORM_CONFIG;
  return normalizeConfigRow(data);
}

export async function fetchAdminPlatformConfig() {
  if (!supabase) return DEFAULT_PLATFORM_CONFIG;
  const { data, error } = await supabase
    .from("app_settings")
    .select("service_name, service_status, points_per_generation, signup_bonus_points, upstream_channel_label, upstream_protocol, upstream_base_url, upstream_api_key, upstream_default_model, upstream_analysis_model")
    .eq("id", SETTINGS_ROW_ID)
    .maybeSingle();
  if (error || !data) return DEFAULT_PLATFORM_CONFIG;
  return normalizeConfigRow(data);
}

export async function fetchCurrentPlatformUser() {
  if (!supabase) return null;
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();
  if (error || !session?.user) {
    return loadDemoPlatformSessionUser();
  }
  try {
    await ensurePlatformUserRemote(session.user.email || "");
    return await fetchPlatformUserById(session.user.id, session.user.email || "");
  } catch (ensureError) {
    if (!isMissingEnsurePlatformUserRpcError(ensureError)) throw ensureError;
    return sessionUserFallback(session.user);
  }
}

export async function ensurePlatformUserRemote(email = "") {
  if (!supabase) return null;
  const { error } = await supabase.rpc("ensure_platform_user", {
    p_email: email || null,
  });
  if (error) throw error;
  return true;
}

export async function fetchPlatformUserById(userId: string, emailFallback = "") {
  if (!supabase || !userId) return null;
  const [{ data: profile, error: profileError }, { data: account, error: accountError }] = await Promise.all([
    supabase.from("profiles").select("id, email, created_at, is_admin").eq("id", userId).maybeSingle(),
    supabase.from("point_accounts").select("balance").eq("user_id", userId).maybeSingle(),
  ]);
  if (profileError) throw profileError;
  if (accountError && accountError.code !== "PGRST116") throw accountError;
  if (!profile) return null;
  return normalizeUserRow(profile, Number(account?.balance) || 0, emailFallback);
}

export async function fetchPlatformUsers() {
  if (!supabase) return [];
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, email, created_at, is_admin")
    .order("created_at", { ascending: false });
  if (error || !profiles?.length) {
    if (error) throw error;
    return [];
  }
  const userIds = profiles.map((item) => item.id);
  const { data: accounts, error: accountError } = await supabase
    .from("point_accounts")
    .select("user_id, balance")
    .in("user_id", userIds);
  if (accountError) throw accountError;
  const pointMap = new Map((accounts || []).map((item) => [item.user_id, Number(item.balance) || 0]));
  return profiles.map((profile) =>
    normalizeUserRow(profile, pointMap.get(profile.id) || 0, profile.email || ""),
  );
}

export async function signUpPlatformUser(email: string, password: string) {
  if (!supabase) throw new Error("Supabase 未配置完成");
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });
  if (error) throw error;
  if (data.session?.user) {
    try {
      await ensurePlatformUserRemote(data.session.user.email || email);
    } catch (ensureError) {
      if (!isMissingEnsurePlatformUserRpcError(ensureError)) throw ensureError;
    }
  }
  return data;
}

export async function signInPlatformUser(email: string, password: string) {
  if (!supabase) throw new Error("Supabase 未配置完成");
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  if (data.session?.user) {
    try {
      await ensurePlatformUserRemote(data.session.user.email || email);
    } catch (ensureError) {
      if (!isMissingEnsurePlatformUserRpcError(ensureError)) throw ensureError;
    }
  }
  return data;
}

export async function signOutPlatformUser() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  clearDemoPlatformSessionUser();
}

export function loadDemoPlatformSessionUser(): PlatformSessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SUPABASE_DEMO_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PlatformSessionUser;
    if (!parsed?.id || !parsed?.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDemoPlatformSessionUser(user: PlatformSessionUser | null) {
  if (typeof window === "undefined") return;
  if (!user) {
    window.localStorage.removeItem(SUPABASE_DEMO_SESSION_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(SUPABASE_DEMO_SESSION_STORAGE_KEY, JSON.stringify(user));
}

export function clearDemoPlatformSessionUser() {
  saveDemoPlatformSessionUser(null);
}

export async function savePlatformConfigRemote(config: PlatformConfig) {
  if (!supabase) return config;
  const payload = {
    id: SETTINGS_ROW_ID,
    service_name: config.serviceName,
    service_status: config.serviceStatus,
    points_per_generation: Math.max(1, Number(config.pointsPerGeneration) || DEFAULT_PLATFORM_CONFIG.pointsPerGeneration),
    signup_bonus_points: Math.max(0, Number(config.signupBonusPoints) || DEFAULT_PLATFORM_CONFIG.signupBonusPoints),
    upstream_channel_label: config.upstreamChannelLabel,
    upstream_protocol: config.upstreamProtocol,
    upstream_base_url: config.upstreamBaseUrl,
    upstream_api_key: config.upstreamApiKey,
    upstream_default_model: config.upstreamDefaultModel,
    upstream_analysis_model: config.upstreamAnalysisModel,
  };
  const { error } = await supabase.from("app_settings").upsert(payload, { onConflict: "id" });
  if (error) throw error;
  return fetchAdminPlatformConfig();
}

export async function adjustPlatformUserPointsRemote(userId: string, delta: number) {
  if (!supabase) return null;
  const { error } = await supabase.rpc("admin_adjust_points", {
    target_user_id: userId,
    delta_amount: Math.trunc(delta),
    reason_text: "admin_console_adjustment",
  });
  if (error) throw error;
  return fetchPlatformUserById(userId);
}

export async function consumeGenerationPointsRemote(amount: number) {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("consume_generation_points", {
    p_amount: Math.max(1, Math.trunc(amount)),
  });
  if (isMissingPlatformSchemaError(error)) return null;
  if (error) throw error;
  return Number(data) || 0;
}

export async function refundGenerationPointsRemote(amount: number) {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("refund_generation_points", {
    p_amount: Math.max(1, Math.trunc(amount)),
  });
  if (isMissingPlatformSchemaError(error)) return null;
  if (error) throw error;
  return Number(data) || 0;
}
