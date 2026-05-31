import { createClient } from "@supabase/supabase-js";

// --- Load Credentials ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Initialize Supabase Client if keys are configured
let isConfigured = !!(supabaseUrl && supabaseAnonKey);
let clientInstance = null;

if (isConfigured) {
    try {
        if (!supabaseUrl.startsWith("http")) {
            throw new Error("Invalid Supabase URL format");
        }
        clientInstance = createClient(supabaseUrl, supabaseAnonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false
            }
        });
    } catch (err) {
        console.error("⚠️ Failed to initialize Supabase client (falling back to Local Sandbox Mode):", err);
        isConfigured = false;
        clientInstance = null;
    }
}

export const isSupabaseConfigured = isConfigured;
export const supabase = clientInstance;


// --- Relational Sandbox Emulation Utilities ---
function getLocalItem<T>(key: string, defaultValue: T): T {
    if (typeof window === "undefined") return defaultValue;
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : defaultValue;
}

function setLocalItem(key: string, data: any) {
    if (typeof window === "undefined") return;
    localStorage.setItem(key, JSON.stringify(data));
}

// Generate high-fidelity UUID simulation
const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

// --- Type Contracts ---
export interface DBUser {
    id: string;
    email: string;
}

export interface DBReport {
    id: string;
    user_id: string;
    company_name: string;
    reporting_period: string;
    file_name: string;
    total_pages: number;
    char_count: number;
    extracted_metrics: any;
    chunks: any[];
    created_at: string;
}

export interface DBChat {
    id: string;
    user_id: string;
    report_id: string | null;
    title: string;
    created_at: string;
    updated_at: string;
}

export interface DBMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at: string;
}

// ========================================================
// THE PERSISTENCE ORCHESTRATOR LAYER
// ========================================================
export const dbOrchestrator = {
    isCloudMode: () => isSupabaseConfigured,

    // --- 1. AUTHENTICATION MODULE ---
    async signUp(email: string, password: string): Promise<DBUser> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
            });
            if (error) throw new Error(error.message);
            if (!data.user) throw new Error("SignUp failed: Empty user details.");
            return { id: data.user.id, email: data.user.email || email };
        } else {
            // Local Sandbox SignUp
            const users = getLocalItem<any[]>("llm_terminal_users", []);
            const cleanEmail = email.trim().toLowerCase();
            if (users.some(u => u.email === cleanEmail)) {
                throw new Error("An account with this email address already exists.");
            }
            if (password.length < 6) {
                throw new Error("Password must be at least 6 characters.");
            }
            const newUser = { id: generateUUID(), email: cleanEmail, password };
            users.push(newUser);
            setLocalItem("llm_terminal_users", users);
            return { id: newUser.id, email: newUser.email };
        }
    },

    async signIn(email: string, password: string): Promise<DBUser> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });
            if (error) throw new Error(error.message);
            if (!data.user) throw new Error("SignIn failed: User details missing.");
            return { id: data.user.id, email: data.user.email || email };
        } else {
            // Local Sandbox SignIn
            const users = getLocalItem<any[]>("llm_terminal_users", []);
            const cleanEmail = email.trim().toLowerCase();
            const matched = users.find(u => u.email === cleanEmail && u.password === password);
            if (!matched) {
                throw new Error("Invalid login credentials. Please verify your email/password.");
            }
            return { id: matched.id, email: matched.email };
        }
    },

    async signOut(): Promise<void> {
        if (isSupabaseConfigured && supabase) {
            const { error } = await supabase.auth.signOut();
            if (error) throw new Error(error.message);
        }
    },

    // --- 2. REPORTS PERSISTENCE MODULE ---
    async saveReport(
        userId: string,
        companyName: string,
        reportingPeriod: string,
        fileName: string,
        totalPages: number,
        charCount: number,
        extractedMetrics: any,
        chunks: any[]
    ): Promise<DBReport> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase
                .from("reports")
                .insert({
                    user_id: userId,
                    company_name: companyName,
                    reporting_period: reportingPeriod,
                    file_name: fileName,
                    total_pages: totalPages,
                    char_count: charCount,
                    extracted_metrics: extractedMetrics,
                    chunks: chunks
                })
                .select()
                .single();
            if (error) throw new Error(error.message);
            return data as DBReport;
        } else {
            // Local Sandbox Save
            const reports = getLocalItem<DBReport[]>("llm_terminal_reports", []);
            const newReport: DBReport = {
                id: generateUUID(),
                user_id: userId,
                company_name: companyName,
                reporting_period: reportingPeriod,
                file_name: fileName,
                total_pages: totalPages,
                char_count: charCount,
                extracted_metrics: extractedMetrics,
                chunks: chunks,
                created_at: new Date().toISOString()
            };
            reports.push(newReport);
            setLocalItem("llm_terminal_reports", reports);
            return newReport;
        }
    },

    async loadReports(userId: string): Promise<DBReport[]> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase
                .from("reports")
                .select("*")
                .eq("user_id", userId)
                .order("created_at", { ascending: false });
            if (error) throw new Error(error.message);
            return data as DBReport[];
        } else {
            // Local Sandbox Load
            const reports = getLocalItem<DBReport[]>("llm_terminal_reports", []);
            return reports.filter(r => r.user_id === userId);
        }
    },

    // --- 3. CHAT PERSISTENCE MODULE ---
    async createChat(userId: string, title: string, reportId: string | null = null): Promise<DBChat> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase
                .from("chats")
                .insert({
                    user_id: userId,
                    title: title,
                    report_id: reportId
                })
                .select()
                .single();
            if (error) throw new Error(error.message);
            return data as DBChat;
        } else {
            // Local Sandbox Create
            const chats = getLocalItem<DBChat[]>("llm_terminal_chats", []);
            const newChat: DBChat = {
                id: generateUUID(),
                user_id: userId,
                report_id: reportId,
                title: title,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            chats.push(newChat);
            setLocalItem("llm_terminal_chats", chats);
            return newChat;
        }
    },

    async loadChats(userId: string): Promise<DBChat[]> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase
                .from("chats")
                .select("*")
                .eq("user_id", userId)
                .order("updated_at", { ascending: false });
            if (error) throw new Error(error.message);
            return data as DBChat[];
        } else {
            // Local Sandbox Load
            const chats = getLocalItem<DBChat[]>("llm_terminal_chats", []);
            return chats
                .filter(c => c.user_id === userId)
                .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        }
    },

    async updateChatTitle(chatId: string, title: string): Promise<void> {
        if (isSupabaseConfigured && supabase) {
            const { error } = await supabase
                .from("chats")
                .update({ title, updated_at: new Date().toISOString() })
                .eq("id", chatId);
            if (error) throw new Error(error.message);
        } else {
            // Local Sandbox Update
            const chats = getLocalItem<DBChat[]>("llm_terminal_chats", []);
            const matched = chats.find(c => c.id === chatId);
            if (matched) {
                matched.title = title;
                matched.updated_at = new Date().toISOString();
                setLocalItem("llm_terminal_chats", chats);
            }
        }
    },

    async deleteChat(chatId: string): Promise<void> {
        if (isSupabaseConfigured && supabase) {
            const { error } = await supabase
                .from("chats")
                .delete()
                .eq("id", chatId);
            if (error) throw new Error(error.message);
        } else {
            // Local Sandbox Delete
            const chats = getLocalItem<DBChat[]>("llm_terminal_chats", []);
            const filteredChats = chats.filter(c => c.id !== chatId);
            setLocalItem("llm_terminal_chats", filteredChats);

            // Also prune related messages
            const messages = getLocalItem<DBMessage[]>("llm_terminal_messages", []);
            const filteredMessages = messages.filter(m => m.chat_id !== chatId);
            setLocalItem("llm_terminal_messages", filteredMessages);
        }
    },

    // --- 4. MESSAGES PERSISTENCE MODULE ---
    async saveMessage(chatId: string, role: "user" | "assistant" | "system", content: string): Promise<DBMessage> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase
                .from("chat_messages")
                .insert({
                    chat_id: chatId,
                    role: role,
                    content: content
                })
                .select()
                .single();
            if (error) throw new Error(error.message);
            
            // Touch chat session updated_at
            await supabase
                .from("chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
                
            return data as DBMessage;
        } else {
            // Local Sandbox Save
            const messages = getLocalItem<DBMessage[]>("llm_terminal_messages", []);
            const newMessage: DBMessage = {
                id: generateUUID(),
                chat_id: chatId,
                role: role,
                content: content,
                created_at: new Date().toISOString()
            };
            messages.push(newMessage);
            setLocalItem("llm_terminal_messages", messages);

            // Touch chat session updated_at
            const chats = getLocalItem<DBChat[]>("llm_terminal_chats", []);
            const matchedChat = chats.find(c => c.id === chatId);
            if (matchedChat) {
                matchedChat.updated_at = new Date().toISOString();
                setLocalItem("llm_terminal_chats", chats);
            }

            return newMessage;
        }
    },

    async loadMessages(chatId: string): Promise<DBMessage[]> {
        if (isSupabaseConfigured && supabase) {
            const { data, error } = await supabase
                .from("chat_messages")
                .select("*")
                .eq("chat_id", chatId)
                .order("created_at", { ascending: true });
            if (error) throw new Error(error.message);
            return data as DBMessage[];
        } else {
            // Local Sandbox Load
            const messages = getLocalItem<DBMessage[]>("llm_terminal_messages", []);
            return messages
                .filter(m => m.chat_id === chatId)
                .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }
    }
};
