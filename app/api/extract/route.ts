import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

interface Chunk {
    id: string;
    text: string;
    page: number;
}

// --- Strictly Defined Zod Schema for Structured Financial Extraction ---
export const financialExtractionSchema = z.object({
    companyName: z.string().describe("The official name of the corporate entity (e.g. Tesla, Inc.)"),
    reportingPeriod: z.string().describe("The exact reporting period, e.g. Q1 2026, FY 2025"),
    metrics: z.object({
        revenue: z.number().describe("Total consolidated revenue in absolute USD values (e.g. 24800000000), or 0 if not found"),
        revenueYoY: z.string().describe("Year-over-year revenue growth percentage (e.g. +11.0% or -3.5%), or 'N/A' if not found"),
        revenueSourcePage: z.number().describe("The physical page number where Revenue is discussed"),
        operatingIncome: z.number().describe("Operating income (or operating profit) in absolute USD, or 0 if not found"),
        operatingIncomeYoY: z.string().describe("Year-over-year operating income shift percentage (e.g., -4.0%), or 'N/A' if not found"),
        operatingIncomeSourcePage: z.number().describe("The physical page number where Operating Income is discussed"),
        grossMargin: z.number().min(0).max(100).describe("Consolidated gross profit margin percentage (e.g., 18.2), or 0 if not found"),
        grossMarginShiftBps: z.number().describe("Gross margin basis points shift year-over-year (e.g., -150 or +50), or 0 if not found"),
        grossMarginSourcePage: z.number().describe("The physical page number where Gross Margin is discussed"),
        freeCashFlow: z.number().describe("Free cash flow in absolute USD values, or 0 if not found"),
        freeCashFlowYoY: z.string().describe("Free cash flow growth percentage YoY, or 'N/A' if not found"),
        freeCashFlowSourcePage: z.number().describe("The physical page number where Free Cash Flow is discussed"),
    }).describe("Consolidated financial metric key figures and their source page references"),
    risks: z.array(z.object({
        vector: z.string().describe("Concise title of the risk vector (e.g. Inventory Backlogs, Lithium Pack Volatility)"),
        description: z.string().describe("A concise 1-2 sentence explanation of the specific risk hazard and its potential balance-sheet impact"),
        sourcePage: z.number().describe("The physical page number where this risk vector is discussed")
    })).max(3).describe("Exactly up to 3 core risk vectors highlighted in the report context with page references"),
    sentiment: z.object({
        executiveTone: z.enum(["Bullish", "Cautious", "Evasive", "Neutral"]).describe("General tone expressed by the management team"),
        score: z.number().min(-1).max(1).describe("Quantitative sentiment rating score from -1.00 (extremely bearish) to +1.00 (extremely bullish)"),
        mentionsAI: z.number().describe("Total number of times 'artificial intelligence', 'generative AI', or 'AI' is mentioned in the text"),
        mentionsLayoffs: z.number().describe("Total number of times layoffs, headcount reductions, downsizing, or restructuring is mentioned in the text"),
        sentimentAnalysis: z.string().describe("A brief 2-sentence explanation justifying why this executive sentiment score was assigned based on quotes")
    }).describe("Management sentiment and key trend remark counts"),
    guidance: z.object({
        outlook: z.string().describe("Executive guidance or outlook summary statement for the upcoming quarters/year"),
        confidence: z.enum(["High", "Medium", "Low"]).describe("Confidence level expressed by management on forward-looking figures"),
        sourcePage: z.number().describe("The physical page number where guidance/outlook is discussed")
    }).describe("Forward outlook guidance forecast details"),
    toneVelocity: z.array(z.object({
        page: z.number().describe("The physical page number"),
        score: z.number().min(-1).max(1).describe("The sentiment score for this page from -1.0 (extremely bearish) to +1.0 (extremely bullish)"),
        dominantTone: z.string().describe("The dominant keyword or tone description for this page (e.g. Executive Optimism, Segment Growth, Margin Compression, Compute Expansion, Risk Disclosures, Guidance Outlook)")
    })).describe("A page-by-page mapping of executive sentiment tone velocity throughout the document, matching exactly the page indexes found in the text context")
});

export async function POST(request: NextRequest) {
    try {
        const { chunks } = await request.json();

        const chunkArray: Chunk[] = Array.isArray(chunks) ? chunks : [];
        if (chunkArray.length === 0) {
            return NextResponse.json(
                { error: "No document chunks provided. Please ingest a PDF first." },
                { status: 400 }
            );
        }

        const clientApiKey = request.headers.get("x-api-key");
        const activeApiKey = clientApiKey || process.env.GEMINI_API_KEY;

        if (!activeApiKey) {
            return NextResponse.json(
                { error: "API Key is missing. Paste your Gemini API key in the settings panel." },
                { status: 401 }
            );
        }

        // Initialize Google AI Studio Provider
        const googleProvider = createGoogleGenerativeAI({
            apiKey: activeApiKey
        });

        // Concatenate chunk texts to form a unified corporate context
        const fullText = chunkArray
            .map(c => `[Page ${c.page}] ${c.text}`)
            .join("\n\n=========================================\n\n");

        let validationError = "";
        let extractedObject = null;
        let attempts = 0;

        // --- Self-Correction Reflection Loop ---
        while (attempts < 3) {
            try {
                const prompt = `You are a high-caliber buy-side equity research analyst and forensic accountant. Your task is to extract highly accurate, verified structured financial intelligence from the corporate document text.

Source Corporate Document Context:
=========================================
${fullText}
=========================================

Instructions:
1. Extract the official reporting company name and period.
2. Extract all core metrics into absolute numbers (e.g. $24.8 Billion -> 24800000000), YoY growth percentages, and pinpoint the exact [Page X] where they are discussed.
3. Identify exactly up to 3 core risk vectors highlighted in the text, noting the exact [Page X] where they are discussed.
4. Evaluate overall management tone, count mentions of AI/layoffs, and map a page-by-page toneVelocity sentiment score array (evaluating each page [Page X] found in the text context sequentially from Page 1 to Page 6).
5. Extract guidance statements, executive confidence levels, and the exact [Page X] where guidance is outlined.

${validationError ? `⚠️ CRITICAL REFLECTION DIRECTIVE: Your previous attempt failed validation with the following schema error:
"${validationError}"

Please review your extracted metrics against the source text. Focus on these constraints:
- Ensure grossMargin is a percentage number between 0 and 100.
- All numbers must be integers/floats, not strings.
- Verify your mathematical calculations against the raw numbers in the context. Correct any hallucinations immediately.` : ""}`;

                const result = await generateObject({
                    model: googleProvider("gemini-2.5-flash"),
                    schema: financialExtractionSchema,
                    prompt: prompt,
                    temperature: 0.1 // Highly deterministic temperature to ensure mathematical correctness
                });

                extractedObject = result.object;
                break; // Succeeded, exit loop!
            } catch (err: any) {
                attempts++;
                validationError = err.message || "Unknown structured extraction validation failure.";
                console.warn(`⚠️ [Self-Correction Reflection Loop] Attempt ${attempts} failed: ${validationError}`);
            }
        }

        if (!extractedObject) {
            throw new Error(`Self-correction failed after 3 attempts. Last schema validation error: ${validationError}`);
        }

        console.log(`\n--- [Structured Ingestion Complete] ---`);
        console.log(`Company:   ${extractedObject.companyName}`);
        console.log(`Period:    ${extractedObject.reportingPeriod}`);
        console.log(`Revenue:   $${extractedObject.metrics.revenue.toLocaleString()}`);
        console.log(`Sentiment: ${extractedObject.sentiment.executiveTone} (${extractedObject.sentiment.score})`);
        console.log(`---------------------------------------\n`);

        return NextResponse.json(extractedObject);
    } catch (error: any) {
      console.error("Structured Extraction Error:", error);
      return NextResponse.json(
          { error: `Structured financial extraction failure: ${error.message}` },
          { status: 500 }
      );
    }
}
