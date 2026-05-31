import { NextRequest, NextResponse } from "next/server";
import { embedMany } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export async function POST(request: NextRequest) {
    try {
        const { texts } = await request.json();
        
        if (!texts || !Array.isArray(texts)) {
            return NextResponse.json(
                { error: "Invalid payload. Provide an array of strings in 'texts'." },
                { status: 400 }
            );
        }

        const clientApiKey = request.headers.get("x-api-key");
        const activeApiKey = clientApiKey || process.env.GEMINI_API_KEY;

        if (!activeApiKey) {
            return NextResponse.json(
                { error: "API Key is missing. Set GEMINI_API_KEY in your environment or paste it in the settings panel." },
                { status: 401 }
            );
        }

        // Initialize Google AI Studio Provider
        const googleProvider = createGoogleGenerativeAI({
            apiKey: activeApiKey
        });

        // Run batch embedding generation using Google's gemini-embedding-001 model
        const { embeddings } = await embedMany({
            model: googleProvider.textEmbeddingModel("gemini-embedding-001"),
            values: texts
        });

        return NextResponse.json({ embeddings });
    } catch (error: any) {
        console.error("Embedding Generation Error:", error);
        return NextResponse.json(
            { error: `Embedding generation failure: ${error.message}` },
            { status: 500 }
        );
    }
}
