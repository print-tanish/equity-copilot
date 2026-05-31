-- ========================================================
-- Equity-Copilot PostgreSQL Schema & Database Migrations
-- Target Platform: Supabase (PostgreSQL)
-- ========================================================

-- Enable UUID generator extension if not already present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- --- 1. REPORTS TABLE (PERSISTENT METRIC REGISTRY) ---
-- Stores parsed corporate documents, extracted KPI stats, text chunks, and embedding vectors.
CREATE TABLE IF NOT EXISTS public.reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    company_name TEXT NOT NULL,
    reporting_period TEXT NOT NULL,
    file_name TEXT NOT NULL,
    total_pages INTEGER NOT NULL,
    char_count INTEGER NOT NULL,
    extracted_metrics JSONB NOT NULL, -- Core metrics structured JSON (Zod contract)
    chunks JSONB NOT NULL,            -- Array of parsed chunks (holding text & semantic vectors)
    created_at TIMESTAMPTZ DEFAULT now()
);

-- --- 2. CHATS TABLE (RESEARCH SESSION PERSISTENCE) ---
-- Stores saved chat workspaces/sessions corresponding to users.
CREATE TABLE IF NOT EXISTS public.chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    report_id UUID REFERENCES public.reports(id) ON DELETE SET NULL, -- Optional link to report context
    title TEXT NOT NULL DEFAULT 'New Research Session',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- --- 3. CHAT MESSAGES TABLE (CONVERSATION HISTORY RECORDS) ---
-- Stores granular logs of user messages and assistant responses within a chat.
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- --- 4. HIGH-PERFORMANCE INDEX OPTIMIZATIONS ---
-- Optimizes query retrieval speed under relational select joins.
CREATE INDEX IF NOT EXISTS idx_reports_user ON public.reports(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_user ON public.chats(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON public.chat_messages(chat_id);

-- --- 5. ROW-LEVEL SECURITY (RLS) POLICIES (SUPABASE PRODUCTION) ---
-- Enables standard security compliance ensuring users can only read/write their own records.
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- Reports RLS Policies
CREATE POLICY "Users can create their own reports" ON public.reports 
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own reports" ON public.reports 
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own reports" ON public.reports 
    FOR DELETE USING (auth.uid() = user_id);

-- Chats RLS Policies
CREATE POLICY "Users can create their own chats" ON public.chats 
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own chats" ON public.chats 
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own chats" ON public.chats 
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own chats" ON public.chats 
    FOR DELETE USING (auth.uid() = user_id);

-- Chat Messages RLS Policies
CREATE POLICY "Users can insert messages into their chats" ON public.chat_messages 
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.chats 
            WHERE chats.id = chat_messages.chat_id AND chats.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can view messages from their chats" ON public.chat_messages 
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.chats 
            WHERE chats.id = chat_messages.chat_id AND chats.user_id = auth.uid()
        )
    );
