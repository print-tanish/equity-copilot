# 📊 Equity-Copilot: AI Financial Intelligence & Semantic RAG Terminal

`Equity-Copilot` is a state-of-the-art, Bloomberg-style buy-side financial research terminal designed to ingest, clean, vector-index, and query corporate financial documents (Annual Reports, Earnings Transcripts, and investor presentations) under secure, multi-user relational persistence.

---

## 🛠️ High-Level System Architecture & Design Patterns

### 1. Dual-Mode Database Fallback Orchestrator (Repository Pattern)
* **The Problem**: Requiring users to configure a cloud database cluster just to view a demo creates significant onboarding friction.
* **The Solution**: Designed a self-healing **Dual-Mode Persistence Orchestrator** in `lib/supabase.ts`.
  * **Cloud Postgres Mode**: Automatically connects and synchronizes sessions, reports, and messages to a hosted Supabase PostgreSQL cluster if credentials exist in `.env.local`.
  * **Local Sandbox Mode**: If keys are absent, the application pivots seamlessly into a client-side database emulation layer using high-fidelity mock tables and UUID generators inside `localStorage` memory—ensuring a zero-configuration demo.

### 2. High-Performance Client-Side RAG & Serialized Embeddings
* **The Problem**: Standard vector databases add costly monthly hosting fees, operational complexity, and REST round-trip latencies for active document search.
* **The Solution**: 
  * Ingested PDFs are temiz-parsed and chunked using a **sliding-window text partitioner**.
  * Chunks are vectorized via `gemini-embedding-001` (768 dimensions).
  * The entire array of text chunks and their dense semantic vectors is serialized and stored directly inside a **unified `JSONB` column (`chunks`)** within the `reports` Postgres table.
  * When a user loads a report, the embeddings are fetched *once*. All subsequent semantic retrieval, keyword matching, and **cosine-similarity calculations** are executed directly in the browser's main thread in **sub-milliseconds**, providing an instant and free RAG system.

### 3. Zod-Validated Structured Metrics Extraction
* Rather than relying on simple, unstructured LLM summaries, our processing pipeline extracts consolidated corporate metrics (Revenue, Operating Income, Gross Margin, and FCF) and enforces strong structural validation through **Zod Schema Contracts** on the API side before saving them to PostgreSQL.

---

## 🚀 Advanced Features (Resume & Interview Ready)

### 📊 A. Bloomberg-Style Inline SVG Charting Comparison
* When comparing different periods (e.g. *Q1 2026 vs Q1 2025*), the terminal computes YoY percentage changes dynamically and renders an **interactive, dual-bar comparative chart** built entirely with responsive, hardware-accelerated inline SVG bars and glassmorphism styling. It requires zero bloated external graphing libraries, preventing package bloat.

### 🕵️‍♂️ B. Real-Time RAG "Trace Log" Debugger Panel
* Attached under every assistant response is a collapsible, high-fidelity **RAG Trace Log Drawer**. It profiles and displays:
  * **Retrieval Latency**: How long the query vectorization and similarity search took (e.g., `18ms`).
  * **Cosine Similarity Match Scores**: Exact similarity percentages (e.g. `Match: 87%`) computed in client-side Javascript.
  * **Granular Chunk Extraction**: The exact page numbers and raw text passages retrieved from the document and supplied to the LLM system prompt.

---

## 📈 Enterprise Scalability & `pgvector` HNSW Roadmap

For small-to-medium files (e.g., individual 10-K filings or quarterly transcripts), client-side RAG over JSONB serializations is incredibly fast and highly cost-effective. However, to scale this system to ingest and query **millions of corporate reports** globally, the architecture transitions to server-side vector search.

### 1. Enabling `pgvector` in Supabase
We activate the PostgreSQL open-source vector extension inside our database cluster:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. Vector Registry Migration
We decouple the `chunks` JSONB column and create a dedicated `report_chunks` relational table containing a specialized 768-dimensional `vector` type column:
```sql
CREATE TABLE public.report_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID REFERENCES public.reports(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    chunk_content TEXT NOT NULL,
    embedding vector(768) NOT NULL -- Decoupled vector column
);
```

### 3. Creating an HNSW (Hierarchical Navigable Small World) Index
Standard sequential scans (`O(N)`) fail under millions of rows. To achieve sub-millisecond, logarithmic (`O(log N)`) retrieval, we construct an **HNSW index** using Cosine distance:
```sql
CREATE INDEX idx_chunks_hnsw_cosine ON public.report_chunks 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```
* *Why HNSW?* Compared to IVFFlat (Inverted File Flat) index types, HNSW does not require a training phase, retains higher search recall, and performs fast Approximate Nearest Neighbor (ANN) searches even as data is dynamically inserted or updated.

### 4. Database RAG Similarity Search Function
We encapsulate the vector search query within a Postgres function to execute similarity calculation directly in the database:
```sql
CREATE OR REPLACE FUNCTION match_report_chunks (
    query_embedding vector(768),
    match_threshold FLOAT,
    match_count INT,
    target_report_id UUID
)
RETURNS TABLE (
    id UUID,
    page_number INT,
    chunk_content TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql ACCESS TO PUBLIC AS $$
BEGIN
    RETURN QUERY
    SELECT
        rc.id,
        rc.page_number,
        rc.chunk_content,
        1 - (rc.embedding <=> query_embedding) AS similarity -- Cosine distance conversion
    FROM public.report_chunks rc
    WHERE rc.report_id = target_report_id
      AND 1 - (rc.embedding <=> query_embedding) > match_threshold
    ORDER BY rc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
```

---

## 💻 Tech Stack
* **Framework**: Next.js 16 (App Router), React 19, TypeScript
* **Database**: Supabase (Cloud PostgreSQL) / Local Storage Sandbox
* **AI Provider**: Google Gemini (`gemini-2.5-flash` stable, `gemini-embedding-001`)
* **Styling**: Vanilla CSS (Bloomberg Terminal aesthetics)
