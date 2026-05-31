import { NextRequest, NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import path from "path";
import { pathToFileURL } from "url";

interface Chunk {
    id: string;
    text: string;
    page: number;
}

function cleanText(text: string): string {
    return text
        .replace(/(\w+)-\n(\w+)/g, "$1$2") // Re-join hyphenated word splits
        .replace(/[ \t]+/g, " ")          // Normalize horizontal white spaces
        .replace(/\n\s*\n/g, "\n\n")      // Normalize paragraph gaps
        .trim();
}

function chunkText(pages: Array<{ num: number; text: string }>, chunkSize = 1000, chunkOverlap = 200): Chunk[] {
    const chunks: Chunk[] = [];
    let chunkCounter = 0;
    
    for (const page of pages) {
        const cleanedText = cleanText(page.text);
        let start = 0;
        
        while (start < cleanedText.length) {
            const end = Math.min(start + chunkSize, cleanedText.length);
            const chunkSlice = cleanedText.substring(start, end).trim();
            
            if (chunkSlice.length > 50) { // Filter out negligible trailing fragments
                chunks.push({
                    id: `chunk_${chunkCounter++}`,
                    text: chunkSlice,
                    page: page.num
                });
            }
            
            start += (chunkSize - chunkOverlap);
            
            // Guard against infinite loop if overlap equals or exceeds chunk size
            if (chunkSize <= chunkOverlap) break;
        }
    }
    
    return chunks;
}

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get("file") as File | null;
        
        if (!file) {
            return NextResponse.json(
                { error: "No file uploaded. Please upload a valid PDF document." }, 
                { status: 400 }
            );
        }
        
        const arrayBuffer = await file.arrayBuffer();
        
        // Explicitly set the PDFJS worker path using file:// protocol to bypass
        // Next.js Server Chunks folder resolution bugs under dev server/Turbopack
        const workerPath = path.resolve("node_modules/pdf-parse/dist/pdf-parse/esm/pdf.worker.mjs");
        const workerUrl = pathToFileURL(workerPath).href;
        PDFParse.setWorker(workerUrl);
        
        // Extract text from buffer using pdf-parse class (v2.4.5+)
        const parser = new PDFParse({ data: arrayBuffer });
        const textResult = await parser.getText();
        const infoResult = await parser.getInfo();
        
        // Perform manual page-by-page chunking
        const chunks = chunkText(textResult.pages, 1000, 200);
        
        return NextResponse.json({
            chunks: chunks,
            numpages: textResult.total,
            info: {
                title: infoResult.info?.Title || file.name,
                author: infoResult.info?.Author || "Unknown",
                creator: infoResult.info?.Creator || "Unknown",
                producer: infoResult.info?.Producer || "Unknown"
            }
        });
    } catch (error: any) {
        console.error("PDF Ingestion Pipeline Error:", error);
        return NextResponse.json(
            { error: `Failed to extract content from PDF: ${error.message}` }, 
            { status: 500 }
        );
    }
}
