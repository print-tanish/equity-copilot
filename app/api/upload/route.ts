import { NextRequest, NextResponse } from "next/server";

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
        const buffer = Buffer.from(arrayBuffer);
        
        // Dynamically import the stable, pure-JS pdf-parse package
        const pdfImport = await import("pdf-parse");
        const pdfParser = (pdfImport.default || pdfImport) as any;
        
        const pages: Array<{ num: number; text: string }> = [];
        const options = {
            pagerender: (pageData: any) => {
                return pageData.getTextContent()
                    .then((textContent: any) => {
                        const text = textContent.items.map((item: any) => item.str).join(" ");
                        pages.push({
                            num: pageData.pageIndex + 1,
                            text: text
                        });
                        return text;
                    });
            }
        };
        
        const textResult = await pdfParser(buffer, options);
        
        // Ensure pages are sorted sequentially
        pages.sort((a, b) => a.num - b.num);
        
        // Perform manual page-by-page chunking
        const chunks = chunkText(pages, 1000, 200);
        
        return NextResponse.json({
            chunks: chunks,
            numpages: textResult.numpages || pages.length,
            info: {
                title: textResult.info?.Title || file.name,
                author: textResult.info?.Author || "Unknown",
                creator: textResult.info?.Creator || "Unknown",
                producer: textResult.info?.Producer || "Unknown"
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
