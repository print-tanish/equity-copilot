import { NextRequest, NextResponse } from "next/server";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText, embed } from "ai";

interface Chunk {
    id: string;
    text: string;
    page: number;
    vector?: number[];
}

// --- Lexical (Sparse) Retrieval Helper ---
function retrieveRelevantChunks(query: string, chunks: Chunk[], topK = 3): Chunk[] {
    if (!chunks || chunks.length === 0) return [];
    
    const queryString = typeof query === "string" ? query : "";
    
    // Normalize and tokenize query into lowercase terms (filtering out standard stopwords)
    const stopwords = new Set(["the", "is", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "this", "that", "these", "those", "what", "which", "how", "why", "who", "where", "whom"]);
    const queryTerms = queryString
        .toLowerCase()
        .replace(/[^\w\s]/g, "") // Strip punctuation
        .split(/\s+/)
        .filter(term => term.trim().length > 0 && !stopwords.has(term));
        
    if (queryTerms.length === 0) {
        // Fallback: return top K chunks if query is empty after stopword filtering
        return chunks.slice(0, topK);
    }
    
    // Calculate simple term frequency similarity score for each chunk
    const scoredChunks = chunks.map(chunk => {
        if (!chunk || !chunk.text) return { chunk, score: 0 };
        const chunkTextLower = chunk.text.toLowerCase();
        let score = 0;
        
        for (const term of queryTerms) {
            // Count occurrences of key terms
            const regex = new RegExp(`\\b${term}\\b`, "g");
            const matches = chunkTextLower.match(regex);
            if (matches) {
                score += matches.length; // Frequency weight
            } else if (chunkTextLower.includes(term)) {
                score += 0.5; // Partial word boundary match fallback
            }
        }
        
        return { chunk, score };
    });
    
    // Sort descending by similarity score
    scoredChunks.sort((a, b) => b.score - a.score);
    
    // Retrieve only chunks that have at least some keyword relevance, otherwise fallback
    const matchingChunks = scoredChunks.filter(item => item.score > 0);
    const results = matchingChunks.length > 0 ? matchingChunks : scoredChunks;
    
    return results
        .slice(0, topK)
        .map(item => item.chunk)
        .filter(c => c && c.text);
}

// --- Semantic (Dense) Retrieval Helpers ---
function cosineSimilarity(a: number[], b: number[]): number {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    if (a.length === 0 || b.length === 0) return 0;
    
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let sumSqA = 0;
    let sumSqB = 0;
    
    for (let i = 0; i < len; i++) {
        const valA = a[i] ?? 0;
        const valB = b[i] ?? 0;
        dot += valA * valB;
        sumSqA += valA * valA;
        sumSqB += valB * valB;
    }
    
    const magA = Math.sqrt(sumSqA);
    const magB = Math.sqrt(sumSqB);
    if (magA === 0 || magB === 0) return 0;
    return dot / (magA * magB);
}

function retrieveSemanticChunks(queryVector: number[], chunks: Chunk[], topK = 3): Chunk[] {
    const scoredChunks = chunks.map(chunk => {
        if (!chunk || !chunk.vector) return { chunk, score: 0 };
        const score = cosineSimilarity(queryVector, chunk.vector);
        return { chunk, score };
    });
    
    // Sort descending by cosine similarity score
    scoredChunks.sort((a, b) => b.score - a.score);
    return scoredChunks
        .slice(0, topK)
        .map(item => item.chunk)
        .filter(c => c && c.text);
}

export async function POST(request: NextRequest) {
    try {
        const { messages, chunks, strategy = "sparse" } = await request.json();

        // Retrieve custom key from client headers (for local settings sandbox flexibility)
        // or fall back to server-side process.env
        const clientApiKey = request.headers.get("x-api-key");
        const activeApiKey = clientApiKey || process.env.GEMINI_API_KEY;

        if (!activeApiKey) {
            return NextResponse.json(
                { error: "API Key is missing. Set GEMINI_API_KEY in your environment or paste it in the settings panel." },
                { status: 401 }
            );
        }

        // Initialize Gemini model dynamically
        const googleProvider = createGoogleGenerativeAI({
            apiKey: activeApiKey
        });

        // 🎯 RAG Pipeline Step: Extract user's latest query
        const lastUserMessage = messages[messages.length - 1]?.content || "";
        
        let retrievedChunks: Chunk[] = [];
        let actualStrategy = strategy;
        
        const chunkArray: Chunk[] = Array.isArray(chunks) ? chunks : [];
        const hasVectors = chunkArray.length > 0 && chunkArray.some(c => c.vector && Array.isArray(c.vector));
        
        if (strategy === "dense") {
            try {
                if (!hasVectors) {
                    throw new Error("No chunk vectors detected in the loaded document catalog.");
                }
                
                // Generate semantic query vector using Gemini's gemini-embedding-001 model
                const { embedding: queryVector } = await embed({
                    model: googleProvider.textEmbeddingModel("gemini-embedding-001"),
                    value: lastUserMessage
                });
                
                retrievedChunks = retrieveSemanticChunks(queryVector, chunkArray, 3);
            } catch (embedError: any) {
                console.warn(`⚠️ [RAG Pipeline Warning] Semantic embeddings search failed: ${embedError.message}. Falling back to Sparse (Keyword) RAG.`);
                actualStrategy = "sparse (fallback)";
                retrievedChunks = retrieveRelevantChunks(lastUserMessage, chunkArray, 3);
            }
        } else {
            // Default: Sparse keyword-similarity retrieval
            retrievedChunks = retrieveRelevantChunks(lastUserMessage, chunkArray, 3);
        }
        
        // Ensure no empty slots exist
        retrievedChunks = retrievedChunks.filter(c => c && c.text);
        
        // Console output to check retrieval quality on dev terminal (very educational!)
        console.log(`\n--- [RAG Engine Retrieval Report] ---`);
        console.log(`Requested Strategy: ${strategy.toUpperCase()}`);
        console.log(`Executed Strategy:  ${actualStrategy.toUpperCase()}`);
        console.log(`Query:              "${lastUserMessage}"`);
        console.log(`Retrieved ${retrievedChunks.length} chunks:`);
        retrievedChunks.forEach((c, idx) => {
            console.log(`  [Chunk #${idx + 1}] ID: ${c.id} | Page: ${c.page} | Sample: "${c.text.substring(0, 85).replace(/\n/g, " ")}..."`);
        });
        console.log(`------------------------------------\n`);

        const retrievedContext = retrievedChunks
            .map(chunk => `[Page ${chunk.page}] ${chunk.text}`)
            .join("\n\n=========================================\n\n");

        const systemPrompt = `You are "Equity-Copilot", a premium, state-of-the-art Buy-Side Financial Analyst and Equity Research Assistant. Your goal is to help investors analyze documents, summarize performance, compare metrics, and isolate balance sheet risks.

Here is the retrieved context of the uploaded PDF corporate documents (Annual Reports, Earnings Transcripts, or investor decks) matching the user's query:
=========================================
${retrievedContext || "No relevant corporate document context could be retrieved for this query."}
=========================================

Instructions:
1. Ground your answers heavily in the retrieved PDF context. Cite the specific Page numbers (e.g. "[Page 3]") whenever extracting figures.
2. If the user asks a question about the document that is not answered in the context, explicitly state "This information is not explicitly mentioned in the retrieved report context" but then provide your best general financial analysis or context.
3. Be quantitative: Focus on Year-over-Year (YoY) growth, margins (gross, operating, net), Free Cash Flow (FCF) calculations, and balance sheet metrics. Use bullet points and tables for structured data comparisons.
4. Maintain a highly professional, skeptical buy-side tone. Do not use generic fluffy summaries. Ask sharp follow-up risk questions.`;

        // Run stream text using Vercel AI SDK (targeting gemini-2.5-flash stable standard for 2026)
        const result = streamText({
            model: googleProvider("gemini-2.5-flash"),
            messages,
            system: systemPrompt,
            temperature: 0.2 // Precise, analytical temperature
        });

        return result.toTextStreamResponse();
    } catch (error: any) {
        console.error("AI Streaming Pipeline Error:", error);
        return NextResponse.json(
            { error: `Inference pipeline failure: ${error.message}` },
            { status: 500 }
        );
    }
}
