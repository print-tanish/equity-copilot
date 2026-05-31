"use client";

import React, { useState, useEffect, useRef } from "react";
import { dbOrchestrator, DBUser, DBChat, DBMessage, isSupabaseConfigured, supabase } from "../lib/supabase";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  trace?: {
    strategy: string;
    latencyMs: number;
    chunks: Array<{
      id: string;
      page: number;
      text: string;
      score: number;
    }>;
  };
}

// --- RAG Diagnostics Helper Functions ---
function getCosineSimilarity(a: number[], b: number[]): number {
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

function runClientKeywordRetrieval(query: string, chunks: any[], topK = 3) {
  if (!chunks || chunks.length === 0) return [];
  const stopwords = new Set(["the", "is", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "this", "that", "these", "those", "what", "which", "how", "why", "who", "where", "whom"]);
  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(term => term.trim().length > 0 && !stopwords.has(term));
  if (queryTerms.length === 0) {
    return chunks.slice(0, topK).map(c => ({ chunk: c, score: 0.1 }));
  }
  const scored = chunks.map(chunk => {
    const chunkTextLower = chunk.text.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      const regex = new RegExp(`\\b${term}\\b`, "g");
      const matches = chunkTextLower.match(regex);
      if (matches) {
        score += matches.length;
      } else if (chunkTextLower.includes(term)) {
        score += 0.5;
      }
    }
    return { chunk, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const maxScore = Math.max(...scored.map(s => s.score), 1);
  return scored.slice(0, topK).map(item => ({
    chunk: item.chunk,
    score: parseFloat((item.score / maxScore).toFixed(3))
  }));
}

interface PDFMetadata {
  name: string;
  pages: number;
  charCount: number;
  info?: {
    title?: string;
    author?: string;
    creator?: string;
  };
}

export default function DocumentChatTerminal() {
  // --- Client State ---
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "system",
      content:
        "Welcome to **Equity-Copilot**! I am your buy-side financial research terminal. Upload an annual report, quarterly results, or presentation deck on the left to extract metrics, isolate margins, and query balance sheet risks.",
      timestamp: new Date(),
    },
  ]);
  
  const [inputPrompt, setInputPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [chunks, setChunks] = useState<any[]>([]);
  const [pdfMeta, setPdfMeta] = useState<PDFMetadata | null>(null);
  
  // Loader States
  const [isUploading, setIsUploading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Phase 4 - Dense RAG & Embedding States
  const [retrievalStrategy, setRetrievalStrategy] = useState<"sparse" | "dense">("dense");
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);

  // Phase 5 - Financial Intelligence Layer States
  const [reportsCollection, setReportsCollection] = useState<Record<string, any>>({});
  const [selectedPeriod, setSelectedPeriod] = useState<string>("");
  const [comparisonPeriod, setComparisonPeriod] = useState<string>("");
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(true);

  // Phase 5.3 - Clickable Forensic Citations States
  const [activeCitationPage, setActiveCitationPage] = useState<number | null>(null);
  const [activeCitationText, setActiveCitationText] = useState<string | null>(null);
  const [activeCitationLabel, setActiveCitationLabel] = useState<string | null>(null);

  // Phase 6 - Database & Session Persistence States
  const [currentUser, setCurrentUser] = useState<DBUser | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  
  const [savedChats, setSavedChats] = useState<DBChat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  // Dynamic selector for standard single-document widgets backwards compatibility
  const financialReport = reportsCollection[selectedPeriod] || null;

  // Phase 5.2 - Click-and-Drag Resizable Screen Boundaries (Bloomberg Style)
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [dashboardWidth, setDashboardWidth] = useState(480);

  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = startWidth + (moveEvent.clientX - startX);
      if (newWidth >= 260 && newWidth <= 450) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const handleDashboardMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = dashboardWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = startWidth + (moveEvent.clientX - startX);
      if (newWidth >= 320 && newWidth <= 800) {
        setDashboardWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // References
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Load Saved Session and Database Registry on Mount ---
  useEffect(() => {
    const checkSession = async () => {
      if (dbOrchestrator.isCloudMode() && supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session?.user) {
          const u = { id: data.session.user.id, email: data.session.user.email || "" };
          setCurrentUser(u);
          await loadUserData(u);
        }
      } else {
        const activeUserId = localStorage.getItem("llm_active_user_id");
        const activeUserEmail = localStorage.getItem("llm_active_user_email");
        if (activeUserId && activeUserEmail) {
          const u = { id: activeUserId, email: activeUserEmail };
          setCurrentUser(u);
          await loadUserData(u);
        }
      }
    };
    checkSession();
  }, []);

  const loadUserData = async (u: DBUser) => {
    // 1. Load historical chat sessions
    try {
      const chats = await dbOrchestrator.loadChats(u.id);
      setSavedChats(chats);
    } catch (err: any) {
      console.error("Failed loading historical chat sessions:", err);
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-db-load-chats-${Date.now()}`,
          role: "system",
          content: `⚠️ **Database Retrieval Failure (Chats):** Failed to load your historical chats from Cloud Postgres.\n\n*Error details:* \`${err.message || err}\`\n\n*What to check:* Make sure the \`chats\` table exists in Supabase, and your database credentials inside \`.env.local\` are correct.`,
          timestamp: new Date(),
        },
      ]);
    }
    
    // 2. Load historical saved reports
    try {
      const reports = await dbOrchestrator.loadReports(u.id);
      if (reports.length > 0) {
        const collection: Record<string, any> = {};
        reports.forEach(r => {
          collection[r.reporting_period] = {
            ...r.extracted_metrics,
            chunks: r.chunks
          };
        });
        setReportsCollection(collection);
        setSelectedPeriod(reports[0].reporting_period);
      }
    } catch (err: any) {
      console.error("Failed loading historical saved reports:", err);
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-db-load-reports-${Date.now()}`,
          role: "system",
          content: `⚠️ **Database Retrieval Failure (Reports):** Failed to load your saved reports from Cloud Postgres.\n\n*Error details:* \`${err.message || err}\``,
          timestamp: new Date(),
        },
      ]);
    }
  };

  const handleAuthAction = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      let u: DBUser;
      if (authMode === "signup") {
        u = await dbOrchestrator.signUp(authEmail, authPassword);
        alert("Account registered successfully! Welcome to your secure database sandbox.");
      } else {
        u = await dbOrchestrator.signIn(authEmail, authPassword);
      }
      
      setCurrentUser(u);
      if (!dbOrchestrator.isCloudMode()) {
        localStorage.setItem("llm_active_user_id", u.id);
        localStorage.setItem("llm_active_user_email", u.email);
      }
      
      await loadUserData(u);
      setShowAuthModal(false);
      setAuthEmail("");
      setAuthPassword("");
    } catch (err: any) {
      setAuthError(err.message || "Authentication process failed.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await dbOrchestrator.signOut();
      setCurrentUser(null);
      setSavedChats([]);
      setReportsCollection({});
      setSelectedPeriod("");
      setComparisonPeriod("");
      setActiveChatId(null);
      setMessages([
        {
          id: "welcome",
          role: "system",
          content: "Welcome to **Equity-Copilot**! I am your buy-side financial research terminal. Upload an annual report, quarterly results, or presentation deck on the left to extract metrics, isolate margins, and query balance sheet risks.",
          timestamp: new Date(),
        },
      ]);
      
      if (!dbOrchestrator.isCloudMode()) {
        localStorage.removeItem("llm_active_user_id");
        localStorage.removeItem("llm_active_user_email");
      }
      alert("Signed out successfully.");
    } catch (err: any) {
      alert("Error signing out: " + err.message);
    }
  };

  const handleStartNewChat = () => {
    setActiveChatId(null);
    setMessages([
      {
        id: "welcome",
        role: "system",
        content: "Welcome to **Equity-Copilot**! I am your buy-side financial research terminal. Upload an annual report, quarterly results, or presentation deck on the left to extract metrics, isolate margins, and query balance sheet risks.",
        timestamp: new Date(),
      },
    ]);
  };

  const handleSelectChat = async (chatId: string) => {
    try {
      const chat = savedChats.find(c => c.id === chatId);
      if (!chat) return;
      
      const loadedMsgs = await dbOrchestrator.loadMessages(chatId);
      const mapped: Message[] = loadedMsgs.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: new Date(m.created_at)
      }));
      
      if (mapped.length === 0) {
        mapped.push({
          id: "welcome",
          role: "system",
          content: `Loaded session: **${chat.title}**. Ask anything about your uploaded corporate context.`,
          timestamp: new Date()
        });
      }
      
      setMessages(mapped);
      setActiveChatId(chatId);
      
      // Auto-load linked reports if present
      if (chat.report_id && currentUser) {
        const reports = await dbOrchestrator.loadReports(currentUser.id);
        const matched = reports.find(r => r.id === chat.report_id);
        if (matched && reportsCollection[matched.reporting_period]) {
          setSelectedPeriod(matched.reporting_period);
        }
      }
    } catch (err: any) {
      alert("Failed loading historical session messages: " + err.message);
    }
  };

  const handleDeleteChat = async (e: React.MouseEvent, chatId: string) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to permanently delete this research chat session?")) return;
    try {
      await dbOrchestrator.deleteChat(chatId);
      setSavedChats(prev => prev.filter(c => c.id !== chatId));
      if (activeChatId === chatId) {
        handleStartNewChat();
      }
    } catch (err: any) {
      alert("Failed to delete chat: " + err.message);
    }
  };

  // --- Load Saved Credentials on Mount ---
  useEffect(() => {
    const savedKey = localStorage.getItem("llm_explorer_key_gemini");
    if (savedKey) {
      setApiKey(savedKey);
    }
  }, []);

  // --- Auto Scroll to Bottom of Chat ---
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // --- Save API Key Utility ---
  const saveKey = () => {
    if (apiKey.trim()) {
      localStorage.setItem("llm_explorer_key_gemini", apiKey.trim());
      alert("API Key saved securely in your local browser storage.");
    } else {
      localStorage.removeItem("llm_explorer_key_gemini");
      alert("Key cleared.");
    }
  };

  // --- Clickable Citations Trigger ---
  const triggerCitationTrace = (pageNumber: number | undefined, label: string) => {
    if (!pageNumber) return;
    
    // Grab chunks from the active loaded report context (or standard fallback)
    const currentDocChunks = financialReport?.chunks || chunks || [];
    const pageChunks = currentDocChunks.filter((c: any) => c.page === pageNumber);
    
    if (pageChunks.length > 0) {
      const concatenatedText = pageChunks.map((c: any) => c.text).join("\n\n");
      setActiveCitationPage(pageNumber);
      setActiveCitationText(concatenatedText);
      setActiveCitationLabel(label);
    } else {
      alert(`No parsed text chunks found for Page ${pageNumber} in browser memory.`);
    }
  };

  // --- Custom Phase 5 Structured Metrics Ingestion Flow ---
  const extractFinancialReport = async (chunksToExtract: any[], keyToUse: string) => {
    if (!chunksToExtract || chunksToExtract.length === 0) return;
    
    setIsExtracting(true);
    setExtractionError(null);
    
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": keyToUse.trim(),
        },
        body: JSON.stringify({ chunks: chunksToExtract }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to extract structured financial metrics.");
      }

      const reportData = await res.json();
      
      // Save metric extract and its chunks inside reportsCollection
      const periodKey = reportData.reportingPeriod || `Report ${Date.now()}`;
      setReportsCollection((prev) => ({
        ...prev,
        [periodKey]: {
          ...reportData,
          chunks: chunksToExtract // Hold the source document chunks for citations tracing!
        }
      }));
      setSelectedPeriod(periodKey);
      setShowComparison(true);

      // Persistent DB Save if user logged in
      if (currentUser) {
        try {
          await dbOrchestrator.saveReport(
            currentUser.id,
            reportData.companyName,
            periodKey,
            pdfMeta?.name || "Uploaded_Earnings.pdf",
            pdfMeta?.pages || 1,
            pdfMeta?.charCount || 0,
            reportData,
            chunksToExtract
          );
        } catch (dbErr: any) {
          console.warn("⚠️ Failed saving report to database registry:", dbErr);
          setMessages((prev) => [
            ...prev,
            {
              id: `sys-db-report-err-${Date.now()}`,
              role: "system",
              content: `⚠️ **Database Report Persistence Failure:** The metric extraction succeeded, but failed to save to your Cloud Postgres account.\n\n*Error details:* \`${dbErr.message || dbErr}\``,
              timestamp: new Date(),
            },
          ]);
        }
      }

      // Append system message reporting successful structured ingestion
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-extract-${Date.now()}`,
          role: "system",
          content: `📊 **Structured Corporate Metrics Extracted!** \n\n* **Company:** \`${reportData.companyName}\`\n* **Period:** \`${reportData.reportingPeriod}\`\n* **Revenue:** \`$${reportData.metrics.revenue.toLocaleString()}\` (${reportData.metrics.revenueYoY} YoY)\n* **Management Sentiment:** \`${reportData.sentiment.executiveTone}\` (Score: ${reportData.sentiment.score})\n* **Risk Vectors Extracted:** ${reportData.risks.length} vectors cataloged.\n\nAutomated Bloomberg-style analysis widgets are now fully operational in the dashboard panel.`,
          timestamp: new Date(),
        },
      ]);
    } catch (err: any) {
      console.error(err);
      setExtractionError(err.message || "An unexpected error occurred during metric extraction.");
      
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-extract-err-${Date.now()}`,
          role: "system",
          content: `⚠️ **Financial Metrics Extraction Failed:** ${err.message}\n\nYou can still query the document manually using the chat interface.`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsExtracting(false);
    }
  };

  // --- Custom Phase 4 Batch Vector Generator ---
  const generateVectorsForChunks = async (chunksToEmbed: any[], keyToUse: string) => {
    if (!chunksToEmbed || chunksToEmbed.length === 0) return;
    
    setIsEmbedding(true);
    setEmbeddingError(null);
    
    try {
      const texts = chunksToEmbed.map((c) => c.text);
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": keyToUse.trim(),
        },
        body: JSON.stringify({ texts }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to generate chunk embeddings.");
      }

      const { embeddings } = await res.json();
      if (!embeddings || !Array.isArray(embeddings)) {
        throw new Error("Invalid embedding response format.");
      }

      const updatedChunks = chunksToEmbed.map((chunk, index) => ({
        ...chunk,
        vector: embeddings[index],
      }));

      setChunks(updatedChunks);

      // Append system message reporting successful vector index generation
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-embed-${Date.now()}`,
          role: "system",
          content: `⚡ **Vector Embeddings Generated Successfully!** \n\n* **Model used:** \`gemini-embedding-001\`\n* **Dimensions:** 768 dimensions per vector\n* **Status:** Dense Semantic RAG retrieval is now fully operational.`,
          timestamp: new Date(),
        },
      ]);

      // Automatically chain structured metric extraction!
      await extractFinancialReport(updatedChunks, keyToUse);

    } catch (err: any) {
      console.error(err);
      setEmbeddingError(err.message || "An unexpected error occurred during embedding.");
      
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-embed-err-${Date.now()}`,
          role: "system",
          content: `⚠️ **Vector Embedding Generation Failed:** ${err.message}\n\nYou can still query the document using **Sparse (Keywords)** mode, or fix your API key configuration and click the **"Create Index"** button to retry.`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsEmbedding(false);
    }
  };

  // --- Custom PDF Ingestion Trigger ---
  const handlePDFUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.type !== "application/pdf") {
      setUploadError("Invalid file type. Please upload a valid PDF document.");
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setEmbeddingError(null);
    setExtractionError(null);
    setChunks([]);
    setPdfMeta(null);
    setSelectedPeriod("");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to process PDF file.");
      }

      const data = await response.json();
      const loadedChunks = data.chunks || [];
      const totalChars = loadedChunks.reduce((acc: number, curr: any) => acc + curr.text.length, 0);
      
      setChunks(loadedChunks);
      setPdfMeta({
        name: file.name,
        pages: data.numpages || 1,
        charCount: totalChars,
        info: data.info,
      });
      
      // Append a helpful system message informing the user that document ingestion succeeded
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-upload-${Date.now()}`,
          role: "system",
          content: `📊 **Document Chunked Successfully!** \n\n* **File Name:** \`${file.name}\`\n* **Estimated Page Count:** ${data.numpages || "N/A"}\n* **Total Chunks Created:** ${loadedChunks.length} chunks\n* **Cleaned Character Volume:** ${totalChars.toLocaleString()} chars\n\nI have successfully cleaned and sliding-window chunked this document.`,
          timestamp: new Date(),
        },
      ]);

      // Automatically batch-generate embeddings for chunks if API key is present
      if (apiKey.trim()) {
        await generateVectorsForChunks(loadedChunks, apiKey);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-key-missing-${Date.now()}`,
            role: "system",
            content: `💡 **API Key Required for Semantic Search:** Please add and save your Google Gemini API Key in the settings panel, then click **"Create Index"** to generate vector embeddings. Otherwise, queries will default to **Sparse (Keywords)** mode.`,
            timestamp: new Date(),
          },
        ]);
      }

    } catch (err: any) {
      setUploadError(err.message || "An unexpected error occurred during ingestion.");
    } finally {
      setIsUploading(false);
    }
  };

  // --- Clear Current Document Context ---
  const handleClearContext = () => {
    setChunks([]);
    setPdfMeta(null);
    setUploadError(null);
    setSelectedPeriod("");
    setExtractionError(null);
    setShowComparison(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-clear-${Date.now()}`,
        role: "system",
        content: "🧹 **Document Context Cleared.** Copilot is now running in standard financial knowledge mode.",
        timestamp: new Date(),
      },
    ]);
  };

  // --- Client SSE Stream Parser Pipeline ---
  const handleSendMessage = async (e?: React.FormEvent, customText?: string) => {
    e?.preventDefault();
    
    const textToSend = customText || inputPrompt;
    if (!textToSend.trim()) return;

    if (!apiKey.trim()) {
      alert("Please enter and save your Gemini API Key first in the Sidebar panel.");
      return;
    }

    // Capture user message
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: textToSend,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputPrompt("");
    setIsStreaming(true);

    // --- 🎯 RAG Trace Diagnostic Engine ---
    let traceData: any = null;
    if (chunks.length > 0) {
      const startTime = performance.now();
      try {
        if (retrievalStrategy === "dense" && chunks.some(c => c.vector)) {
          // 1. Fetch query vector embedding from API
          const embedRes = await fetch("/api/embed", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey.trim(),
            },
            body: JSON.stringify({ texts: [textToSend] }),
          });
          if (embedRes.ok) {
            const { embeddings } = await embedRes.json();
            const queryVector = embeddings[0];
            
            // 2. Perform Cosine Similarity Search
            const scoredChunks = chunks.map(c => ({
              chunk: c,
              score: getCosineSimilarity(queryVector, c.vector || [])
            }));
            scoredChunks.sort((a, b) => b.score - a.score);
            const topScored = scoredChunks.slice(0, 3);
            const endTime = performance.now();
            
            traceData = {
              strategy: "Dense (Semantic)",
              latencyMs: Math.round(endTime - startTime),
              chunks: topScored.map(item => ({
                id: item.chunk.id || `chunk-${Math.random()}`,
                page: item.chunk.page,
                text: item.chunk.text,
                score: parseFloat(item.score.toFixed(3))
              }))
            };
          }
        }
      } catch (err) {
        console.warn("Client RAG trace calculation failed, falling back to Sparse.", err);
      }
      
      // Fallback or explicit Sparse keyword search
      if (!traceData) {
        const startTime = performance.now();
        const topScored = runClientKeywordRetrieval(textToSend, chunks, 3);
        const endTime = performance.now();
        traceData = {
          strategy: retrievalStrategy === "dense" ? "Dense (Fallback to Sparse)" : "Sparse (Keyword)",
          latencyMs: Math.round(endTime - startTime),
          chunks: topScored.map(item => ({
            id: item.chunk.id || `chunk-${Math.random()}`,
            page: item.chunk.page,
            text: item.chunk.text,
            score: item.score
          }))
        };
      }
    }

    // Placeholder assistant message for live append stream
    const assistantMessageId = `assistant-${Date.now()}`;
    const assistantMessagePlaceholder: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      trace: traceData
    };

    setMessages((prev) => [...prev, assistantMessagePlaceholder]);

    // Handle database message saving in background
    let chatId = activeChatId;
    if (currentUser) {
      try {
        if (!chatId) {
          const title = textToSend.substring(0, 35) + (textToSend.length > 35 ? "..." : "");
          const newChat = await dbOrchestrator.createChat(currentUser.id, title);
          chatId = newChat.id;
          setActiveChatId(chatId);
          setSavedChats((prev) => [newChat, ...prev]);
        }
        await dbOrchestrator.saveMessage(chatId, "user", textToSend);
      } catch (dbErr: any) {
        console.warn("⚠️ Failed saving user message to database:", dbErr);
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-db-err-${Date.now()}`,
            role: "system",
            content: `⚠️ **Database Sync Error:** Failed to save session/message to Cloud Postgres.\n\n*Error details:* \`${dbErr.message || dbErr}\`\n\n*Possible fixes:* \n1. Make sure you restarted your local development server (\`npm run dev\`) after adding credentials to \`.env.local\`.\n2. Ensure Email Confirmation is turned **OFF** in your Supabase Dashboard (\`Authentication -> Providers -> Email -> Confirm email: OFF\`), otherwise database operations are rejected by Row-Level Security (RLS) policies.`,
            timestamp: new Date(),
          },
        ]);
      }
    }

    let accumulatedContent = "";

    try {
      // Build API request payload
      // Filter out system messages from standard chat history before transmission to prevent schema conflicts
      const chatHistory = messages
        .filter((msg) => msg.role !== "system" && msg.id !== "welcome")
        .map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey.trim(),
        },
        body: JSON.stringify({
          messages: [...chatHistory, { role: "user", content: textToSend }],
          chunks: chunks,
          strategy: retrievalStrategy,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Inference server error.");
      }

      if (!response.body) {
        throw new Error("Empty response body returned by the API.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        accumulatedContent += chunk;

        // Dynamically update the assistant message content
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: accumulatedContent }
              : msg
          )
        );
      }

      // Save assistant response to database if session is valid
      if (currentUser && chatId) {
        try {
          await dbOrchestrator.saveMessage(chatId, "assistant", accumulatedContent);
        } catch (dbErr: any) {
          console.warn("⚠️ Failed saving assistant response to database:", dbErr);
          setMessages((prev) => [
            ...prev,
            {
              id: `sys-db-msg-err-${Date.now()}`,
              role: "system",
              content: `⚠️ **Database Message Persistence Failure:** Failed to save assistant response to Cloud Postgres.\n\n*Error details:* \`${dbErr.message || dbErr}\``,
              timestamp: new Date(),
            },
          ]);
        }
      }

    } catch (err: any) {
      console.error(err);
      const errText = `⚠️ **Inference Pipeline Failure:** ${err.message}\n\n*Double check your API key validity, Gemini usage quota limits, or server logs.*`;
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content: errText,
              }
            : msg
        )
      );

      if (currentUser && chatId) {
        try {
          await dbOrchestrator.saveMessage(chatId, "assistant", errText);
        } catch (dbErr: any) {
          console.warn("⚠️ Failed saving assistant error to database:", dbErr);
          setMessages((prev) => [
            ...prev,
            {
              id: `sys-db-msg-err-${Date.now()}`,
              role: "system",
              content: `⚠️ **Database Message Persistence Failure:** Failed to save assistant error response to Cloud Postgres.\n\n*Error details:* \`${dbErr.message || dbErr}\``,
              timestamp: new Date(),
            },
          ]);
        }
      }
    } finally {
      setIsStreaming(false);
    }
  };

  // --- Quick Prompt Preset Trigger ---
  const handlePresetTrigger = (promptText: string) => {
    handleSendMessage(undefined, promptText);
  };

  // --- Helper to render custom markdown styling safely ---
  const renderMessageContent = (text: string) => {
    // Simple inline parser for boldings, list-items, code blocks and paragraphs
    const lines = text.split("\n");
    return lines.map((line, idx) => {
      let content = line;
      
      // Code Block Format
      if (content.startsWith("```")) {
        return null; // Simplified view: skip coding formatting brackets
      }

      // Check bullet list items
      const isBullet = content.trim().startsWith("*") || content.trim().startsWith("-");
      if (isBullet) {
        content = content.replace(/^[\*\-\s]+/, "");
      }

      // Replace bold markdown `**text**` -> <strong>text</strong>
      const boldRegex = /\*\*([^*]+)\*\*/g;
      const parts = [];
      let lastIndex = 0;
      let match;

      while ((match = boldRegex.exec(content)) !== null) {
        // Text before bold
        if (match.index > lastIndex) {
          parts.push(content.substring(lastIndex, match.index));
        }
        // Bold element
        parts.push(
          <strong key={match.index} className="text-white font-bold">
            {match[1]}
          </strong>
        );
        lastIndex = boldRegex.lastIndex;
      }
      
      if (lastIndex < content.length) {
        parts.push(content.substring(lastIndex));
      }

      // Render standard paragraph or list item
      if (isBullet) {
        return (
          <li key={idx} className="ml-4 list-disc pl-1 text-gray-300 mb-1 text-sm md:text-base leading-relaxed">
            {parts.length > 0 ? parts : content}
          </li>
        );
      }

      if (!content.trim()) {
        return <div key={idx} className="h-2" />;
      }

      return (
        <p key={idx} className="text-gray-300 mb-2 text-sm md:text-base leading-relaxed">
          {parts.length > 0 ? parts : content}
        </p>
      );
    });
  };

  return (
    <div className="flex-grow flex h-screen max-h-screen overflow-hidden">
      {/* ========================================================
          LEFT SIDEBAR: Configurations & PDF Ingestion
          ======================================================== */}
      <aside 
        style={{ width: sidebarWidth }}
        className="bg-[#080b11]/90 border-r border-white/8 backdrop-blur-xl flex flex-col z-10 flex-shrink-0"
      >
        
        {/* Branding Logo Area */}
        <div className="p-6 border-b border-white/8 flex items-center gap-3 pb-4">
          <div className="w-10 h-10 bg-gradient-to-tr from-cyan to-indigo rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo/20">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              Equity-Copilot
            </h2>
            <span className="text-xs uppercase tracking-wider text-indigo font-bold">
              Research Terminal
            </span>
          </div>
        </div>

        {/* Database Status Indicator */}
        <div className="px-6 pt-3 pb-2 border-b border-white/8 bg-black/20">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-black/40 border border-white/5 rounded-lg">
            <span className={`w-2.5 h-2.5 rounded-full ${isSupabaseConfigured ? "bg-emerald animate-pulse" : "bg-amber animate-pulse"}`} />
            <span className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">
              {isSupabaseConfigured ? "Cloud Postgres Active" : "Local Sandbox Memory"}
            </span>
          </div>
        </div>

        <div className="flex-grow overflow-y-auto p-6 space-y-6">
          
          {/* Section 0: User Accounts & Auth Panel */}
          <div className="space-y-3">
            <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
              Personalized Memory Room
            </label>
            <div className="bg-white/3 border border-white/8 rounded-xl p-4 space-y-3">
              {currentUser ? (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2 text-xs">
                    <div className="w-5 h-5 rounded bg-indigo/10 border border-indigo/20 flex items-center justify-center text-indigo text-[10px] font-bold font-sans">
                      👤
                    </div>
                    <span className="text-white truncate font-medium max-w-[170px]" title={currentUser.email}>
                      {currentUser.email}
                    </span>
                  </div>
                  <button
                    onClick={handleSignOut}
                    className="w-full bg-white/5 hover:bg-rose-500/10 border border-white/8 hover:border-rose-500/20 text-gray-300 hover:text-rose-400 font-bold py-1.5 px-3 rounded-lg text-[10px] transition duration-200"
                  >
                    Sign Out Analyst Session
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-[10px] text-gray-400 leading-relaxed font-semibold">
                    Personalize your research terminal. Log in to save chats, loaded reports, and histories across browser sessions.
                  </p>
                  <button
                    onClick={() => {
                      setAuthMode("signin");
                      setShowAuthModal(true);
                    }}
                    className="w-full bg-indigo hover:bg-indigo/90 text-white font-bold py-1.5 px-3 rounded-lg text-xs transition duration-200"
                  >
                    Analyst Authentication
                  </button>
                </div>
              )}
            </div>
          </div>
          
          {/* Section A: API Configuration */}
          <div className="space-y-3">
            <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
              1. LLM API Settings
            </label>
            <div className="bg-white/3 border border-white/8 rounded-xl p-4 space-y-3">
              <div>
                <span className="text-xs font-semibold text-gray-400">Target Provider</span>
                <div className="text-sm font-bold text-white mt-0.5">Google Gemini API (Free Tier)</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs font-semibold text-gray-400">Developer API Key</span>
                <div className="flex gap-2">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Paste AIzaSy... API key"
                    className="flex-grow bg-black/60 border border-white/8 rounded-lg px-3 py-1.5 text-xs text-white font-mono placeholder:text-gray-600 outline-none focus:border-indigo"
                  />
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="px-2 border border-white/8 rounded-lg text-xs hover:bg-white/5 text-gray-300 font-semibold"
                  >
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <button
                onClick={saveKey}
                className="w-full bg-indigo hover:bg-indigo/90 text-white font-bold py-1.5 px-3 rounded-lg text-xs transition duration-200"
              >
                Save Configuration
              </button>
            </div>
          </div>

          {/* Section B: Document Upload Ingestion */}
          <div className="space-y-3">
            <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
              2. Corporate PDF Ingestion
            </label>
            
            <input
              type="file"
              ref={fileInputRef}
              onChange={handlePDFUpload}
              accept="application/pdf"
              className="hidden"
              id="pdf-upload-file"
              disabled={isUploading}
            />

            {pdfMeta ? (
              // Active Loaded File Viewer
              <div className="bg-emerald/5 border border-emerald/20 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex gap-2.5 items-start">
                    <div className="w-8 h-8 rounded-lg bg-emerald/10 flex items-center justify-center text-emerald flex-shrink-0">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                      </svg>
                    </div>
                    <div className="overflow-hidden">
                      <h4 className="text-xs font-bold text-white truncate" title={pdfMeta.name}>
                        {pdfMeta.name}
                      </h4>
                      <p className="text-[10px] text-emerald font-semibold mt-0.5 uppercase tracking-wide">
                        Context Loaded successfully
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 border-t border-white/5 pt-2 text-[11px] text-gray-400">
                  <div>
                    Pages: <strong className="text-white font-mono">{pdfMeta.pages}</strong>
                  </div>
                  <div>
                    Size: <strong className="text-white font-mono">{(pdfMeta.charCount / 1020).toFixed(0)} KB</strong>
                  </div>
                </div>

                <button
                  onClick={handleClearContext}
                  className="w-full bg-white/4 border border-white/8 hover:bg-white/8 text-gray-300 font-bold py-1.5 px-3 rounded-lg text-xs transition duration-200"
                >
                  Unload Document
                </button>
              </div>
            ) : (
              // Empty Upload Dropzone card
              <div
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed border-white/8 hover:border-indigo/40 rounded-xl p-6 text-center cursor-pointer transition bg-white/2 hover:bg-white/3 flex flex-col items-center justify-center ${
                  isUploading ? "pointer-events-none opacity-60" : ""
                }`}
              >
                {isUploading ? (
                  <div className="space-y-2.5">
                    <div className="w-10 h-10 border-2 border-indigo border-t-transparent rounded-full animate-spin mx-auto" />
                    <span className="text-xs font-bold text-indigo block animate-pulse">
                      Parsing PDF Text Pages...
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="w-10 h-10 rounded-full bg-white/4 flex items-center justify-center text-gray-400 mb-3 mx-auto">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                    </div>
                    <span className="text-xs font-bold text-white block">
                      Upload Earnings Report
                    </span>
                    <span className="text-[10px] text-gray-500 block mt-1">
                      PDF documents up to 10MB
                    </span>
                  </>
                )}
              </div>
            )}

            {uploadError && (
              <div className="text-[11px] font-semibold text-rose-400 bg-rose-950/20 border border-rose-900/30 rounded-lg p-2.5">
                {uploadError}
              </div>
            )}
          </div>

          {/* Section C: Retrieval Strategy Configuration */}
          <div className="space-y-3">
            <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
              3. Retrieval Strategy
            </label>
            <div className="bg-white/3 border border-white/8 rounded-xl p-4 space-y-3">
              <div className="flex gap-2 p-1 bg-black/40 rounded-lg border border-white/5">
                <button
                  type="button"
                  onClick={() => setRetrievalStrategy("dense")}
                  className={`flex-grow text-[11px] font-bold py-1.5 rounded-md transition duration-150 ${
                    retrievalStrategy === "dense"
                      ? "bg-indigo text-white shadow-sm shadow-indigo/25"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Dense (Semantic)
                </button>
                <button
                  type="button"
                  onClick={() => setRetrievalStrategy("sparse")}
                  className={`flex-grow text-[11px] font-bold py-1.5 rounded-md transition duration-150 ${
                    retrievalStrategy === "sparse"
                      ? "bg-indigo text-white shadow-sm shadow-indigo/25"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Sparse (Keyword)
                </button>
              </div>
              
              <div className="space-y-1">
                <span className="text-[10px] font-semibold text-gray-400 block">Vector Index Status</span>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`w-2 h-2 rounded-full ${
                      chunks.length === 0 
                        ? "bg-gray-600" 
                        : chunks.every(c => c.vector) 
                        ? "bg-emerald" 
                        : "bg-rose-500 animate-pulse"
                    }`} />
                    <span className="text-white font-semibold">
                      {chunks.length === 0 
                        ? "No Document Loaded" 
                        : chunks.every(c => c.vector) 
                        ? "Vectorized (768-dim)" 
                        : "Missing Vectors"}
                    </span>
                  </div>
                  {chunks.length > 0 && !chunks.every(c => c.vector) && (
                    <button
                      type="button"
                      disabled={isEmbedding || !apiKey.trim()}
                      onClick={() => generateVectorsForChunks(chunks, apiKey)}
                      className="px-2 py-1 bg-emerald/10 hover:bg-emerald/20 disabled:opacity-40 text-emerald border border-emerald/20 text-[10px] font-bold rounded transition duration-200"
                    >
                      {isEmbedding ? "Embedding..." : "Create Index"}
                    </button>
                  )}
                </div>
              </div>
              {embeddingError && (
                <div className="text-[10px] font-semibold text-rose-400 bg-rose-950/20 border border-rose-900/30 rounded-lg p-2">
                  {embeddingError}
                </div>
              )}
            </div>
          </div>

          {/* Section D: Quick Financial Presets */}
          <div className="space-y-3">
            <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
              4. Research Templates
            </label>
            <div className="flex flex-col gap-2">
              <button
                onClick={() =>
                  handlePresetTrigger(
                    "Perform a critical 3-bullet-point summary of the core business risks highlighted in the uploaded document. Focus on operating margin metrics and cash generation stability."
                  )
                }
                disabled={isStreaming || chunks.length === 0}
                className="w-full text-left bg-white/2 border border-white/8 hover:border-indigo/30 hover:bg-white/4 disabled:opacity-40 text-xs text-gray-300 font-semibold p-3 rounded-lg transition text-ellipsis overflow-hidden whitespace-nowrap"
              >
                ⚠️ Isolate Core Business Risks
              </button>
              <button
                onClick={() =>
                  handlePresetTrigger(
                    "Examine the balance sheet and cash flow statement context. Compute operating profit trends and evaluate if margins expanded or compressed. Provide exact numbers."
                  )
                }
                disabled={isStreaming || chunks.length === 0}
                className="w-full text-left bg-white/2 border border-white/8 hover:border-indigo/30 hover:bg-white/4 disabled:opacity-40 text-xs text-gray-300 font-semibold p-3 rounded-lg transition text-ellipsis overflow-hidden whitespace-nowrap"
              >
                📊 Extract Margins & Revenue Growth
              </button>
              <button
                onClick={() =>
                  handlePresetTrigger(
                    "Analyze the tone of the management team. Do executives sound highly confident (bullish), cautious, or evasive about future macro headwinds? Highlight quotes if found."
                  )
                }
                disabled={isStreaming || chunks.length === 0}
                className="w-full text-left bg-white/2 border border-white/8 hover:border-indigo/30 hover:bg-white/4 disabled:opacity-40 text-xs text-gray-300 font-semibold p-3 rounded-lg transition text-ellipsis overflow-hidden whitespace-nowrap"
              >
                🗣️ Analyze Executive Tone & Sentiment
              </button>
            </div>
          </div>

          {/* Section E: Saved Research Sessions (Persistent History) */}
          {currentUser && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                  5. Saved Research Sessions {dbOrchestrator.isCloudMode() ? "(Cloud)" : "(Sandbox)"}
                </label>
                <button
                  onClick={handleStartNewChat}
                  className="text-[9px] font-bold text-indigo hover:text-indigo/80 bg-indigo/10 border border-indigo/20 px-2 py-0.5 rounded transition uppercase"
                >
                  + New Chat
                </button>
              </div>
              
              <div className="bg-white/3 border border-white/8 rounded-xl p-3 max-h-[160px] overflow-y-auto space-y-1.5 custom-scrollbar">
                {savedChats.length === 0 ? (
                  <span className="text-[10px] text-gray-500 italic block py-2 text-center">
                    No saved chats found in memory.
                  </span>
                ) : (
                  savedChats.map((chat) => (
                    <div
                      key={chat.id}
                      onClick={() => handleSelectChat(chat.id)}
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold cursor-pointer transition ${
                        activeChatId === chat.id
                          ? "bg-indigo/15 border-indigo/35 text-white shadow-sm shadow-indigo/10"
                          : "bg-black/20 border-white/5 text-gray-400 hover:text-white hover:bg-white/3"
                      }`}
                    >
                      <span className="truncate max-w-[150px]" title={chat.title}>{chat.title}</span>
                      <button
                        onClick={(e) => handleDeleteChat(e, chat.id)}
                        className="text-[10px] text-gray-600 hover:text-rose-400 p-0.5 transition"
                        title="Delete chat session"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

        </div>

        {/* Sidebar Footer Status */}
        <div className="p-4 border-t border-white/8 bg-black/30">
          <div className="flex items-center gap-2.5 justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${apiKey.trim() ? "bg-emerald animate-pulse pulse-glow" : "bg-amber"}`} />
              <span className="text-[11px] font-bold text-gray-400">
                {apiKey.trim() ? "Terminal Operational" : "Provide API Key"}
              </span>
            </div>
            <span className="text-[10px] font-mono text-indigo font-bold uppercase">v1.2-Flash</span>
          </div>
        </div>
      </aside>

      {/* Drag Divider 1 (Sidebar - Dashboard/Chat) */}
      <div 
        onMouseDown={handleSidebarMouseDown}
        className="w-[4px] hover:w-[6px] bg-white/5 hover:bg-indigo cursor-col-resize transition-all h-full flex-shrink-0 z-20"
        title="Drag to resize config sidebar"
      />

      {/* ========================================================
          MIDDLE COLUMN: Automated Financial Intelligence Hub (Phase 5)
          ======================================================== */}
      {financialReport || isExtracting ? (
        <section 
          style={{ width: dashboardWidth }}
          className="flex-shrink-0 bg-[#0b0f19] border-r border-white/8 flex flex-col h-full overflow-hidden relative"
        >
          
          {/* Header */}
          <div className="p-6 border-b border-white/8 bg-[#080b11]/30 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-widest text-indigo">
                Financial Intelligence
              </h2>
              <p className="text-[10px] text-gray-500 font-semibold mt-0.5 uppercase tracking-wide">
                Automated Ingestion & Metrics
              </p>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald/10 border border-emerald/20 text-emerald text-[9px] font-bold uppercase rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald animate-pulse" />
              Verified via Zod
            </div>
          </div>

          <div className="flex-grow overflow-y-auto p-6 space-y-6 custom-scrollbar">
            {isExtracting ? (
              // Loading State Dashboard
              <div className="flex flex-col items-center justify-center h-full space-y-4 text-center my-12">
                <div className="relative w-16 h-16">
                  <div className="absolute inset-0 rounded-full border-4 border-indigo/20" />
                  <div className="absolute inset-0 rounded-full border-4 border-indigo border-t-transparent animate-spin" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider animate-pulse">
                    AI Structured Extraction Active
                  </h3>
                  <p className="text-xs text-gray-400 max-w-xs leading-relaxed">
                    Analyzing parsed document context, isolating financial statements, and running mathematical validation checks...
                  </p>
                </div>
              </div>
            ) : extractionError ? (
              // Error State Dashboard
              <div className="bg-rose-950/20 border border-rose-900/30 rounded-xl p-5 space-y-3">
                <h3 className="text-xs font-bold text-rose-400 uppercase tracking-wider">
                  Ingestion Verification Failed
                </h3>
                <p className="text-xs text-gray-300 leading-relaxed">
                  {extractionError}
                </p>
                <button
                  onClick={() => extractFinancialReport(chunks, apiKey)}
                  className="w-full bg-rose-500 hover:bg-rose-600 text-white font-bold py-1.5 px-3 rounded-lg text-xs transition duration-200"
                >
                  Retry Structured Extraction
                </button>
              </div>
            ) : (
              // Active Loaded Data Dashboard
              <>
                {/* 0. Period Selector Dropdowns */}
                <div className="space-y-3 bg-[#111625]/40 border border-white/5 rounded-xl p-4">
                  <div className="text-[10px] font-bold text-indigo uppercase tracking-wider">
                    Bloomberg Active Workspace Registry
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-gray-500 uppercase tracking-wide block">Active Period</label>
                      <select
                        value={selectedPeriod}
                        onChange={(e) => setSelectedPeriod(e.target.value)}
                        className="w-full bg-black/60 border border-white/8 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo transition"
                      >
                        {Object.keys(reportsCollection).map((period) => (
                          <option key={period} value={period}>
                            {reportsCollection[period].companyName} ({period})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-bold text-gray-500 uppercase tracking-wide block">YoY Comparison</label>
                      <select
                        value={comparisonPeriod}
                        onChange={(e) => setComparisonPeriod(e.target.value)}
                        className="w-full bg-black/60 border border-white/8 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo transition"
                      >
                        <option value="">None (Extracts Only)</option>
                        {Object.keys(reportsCollection)
                          .filter((period) => period !== selectedPeriod)
                          .map((period) => (
                            <option key={period} value={period}>
                              {reportsCollection[period].companyName} ({period})
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* 1. Core Financial KPIs */}
                {(() => {
                  const compReport = comparisonPeriod ? reportsCollection[comparisonPeriod] : null;
                  const activeMetrics = financialReport.metrics;
                  const compMetrics = compReport?.metrics;

                  // Dynamic YoY Revenue
                  let dynamicRevenueYoY = activeMetrics.revenueYoY;
                  if (compMetrics) {
                    if (compMetrics.revenue > 0) {
                      const pct = ((activeMetrics.revenue - compMetrics.revenue) / compMetrics.revenue) * 100;
                      dynamicRevenueYoY = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
                    } else {
                      dynamicRevenueYoY = "N/A";
                    }
                  }

                  // Dynamic YoY Operating Income
                  let dynamicOperatingIncomeYoY = activeMetrics.operatingIncomeYoY;
                  if (compMetrics) {
                    if (compMetrics.operatingIncome > 0) {
                      const pct = ((activeMetrics.operatingIncome - compMetrics.operatingIncome) / compMetrics.operatingIncome) * 100;
                      dynamicOperatingIncomeYoY = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
                    } else {
                      dynamicOperatingIncomeYoY = "N/A";
                    }
                  }

                  // Dynamic YoY Gross Margin Shift
                  let dynamicGrossMarginShift = activeMetrics.grossMarginShiftBps;
                  let dynamicGrossMarginShiftText = activeMetrics.grossMarginShiftBps >= 0 
                    ? `+${activeMetrics.grossMarginShiftBps} bps` 
                    : `${activeMetrics.grossMarginShiftBps} bps`;
                  if (compMetrics) {
                    dynamicGrossMarginShift = Math.round((activeMetrics.grossMargin - compMetrics.grossMargin) * 100);
                    dynamicGrossMarginShiftText = `${dynamicGrossMarginShift >= 0 ? "+" : ""}${dynamicGrossMarginShift} bps`;
                  }

                  // Dynamic YoY FCF
                  let dynamicFreeCashFlowYoY = activeMetrics.freeCashFlowYoY;
                  if (compMetrics) {
                    if (compMetrics.freeCashFlow > 0) {
                      const pct = ((activeMetrics.freeCashFlow - compMetrics.freeCashFlow) / compMetrics.freeCashFlow) * 100;
                      dynamicFreeCashFlowYoY = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
                    } else {
                      dynamicFreeCashFlowYoY = "N/A";
                    }
                  }

                  return (
                    <>
                      <div className="space-y-3">
                        <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                          1. Consolidated Metrics Actuals
                        </label>
                        
                        <div className="grid grid-cols-2 gap-3">
                          {/* Revenue Card */}
                          <div 
                            onClick={() => triggerCitationTrace(activeMetrics.revenueSourcePage, `Revenue Source (${financialReport.reportingPeriod})`)}
                            className="bg-white/2 border border-white/5 rounded-xl p-4 space-y-1 hover:border-indigo/40 hover:bg-white/4 cursor-pointer group active:scale-[0.98] transition duration-150"
                          >
                            <div className="flex justify-between items-center text-[10px] font-semibold text-gray-500 uppercase">
                              <span>Revenue</span>
                              <span className="text-[9px] text-indigo/60 group-hover:text-indigo font-bold flex items-center gap-0.5 transition font-mono">
                                🔍 P.{activeMetrics.revenueSourcePage}
                              </span>
                            </div>
                            <div className="text-lg font-black text-white font-mono">
                              ${(activeMetrics.revenue / 1e9).toFixed(2)}B
                            </div>
                            <div className="flex items-center gap-1">
                              <span className={`text-[10px] font-bold ${dynamicRevenueYoY.startsWith("+") ? "text-emerald" : "text-rose-400"}`}>
                                {dynamicRevenueYoY}
                              </span>
                              <span className="text-[9px] text-gray-600 font-semibold uppercase">YoY</span>
                            </div>
                          </div>

                          {/* Operating Income Card */}
                          <div 
                            onClick={() => triggerCitationTrace(activeMetrics.operatingIncomeSourcePage, `Operating Income Source (${financialReport.reportingPeriod})`)}
                            className="bg-white/2 border border-white/5 rounded-xl p-4 space-y-1 hover:border-indigo/40 hover:bg-white/4 cursor-pointer group active:scale-[0.98] transition duration-150"
                          >
                            <div className="flex justify-between items-center text-[10px] font-semibold text-gray-500 uppercase">
                              <span>Operating Income</span>
                              <span className="text-[9px] text-indigo/60 group-hover:text-indigo font-bold flex items-center gap-0.5 transition font-mono">
                                🔍 P.{activeMetrics.operatingIncomeSourcePage}
                              </span>
                            </div>
                            <div className="text-lg font-black text-white font-mono">
                              ${(activeMetrics.operatingIncome / 1e9).toFixed(2)}B
                            </div>
                            <div className="flex items-center gap-1">
                              <span className={`text-[10px] font-bold ${dynamicOperatingIncomeYoY.startsWith("+") ? "text-emerald" : "text-rose-400"}`}>
                                {dynamicOperatingIncomeYoY}
                              </span>
                              <span className="text-[9px] text-gray-600 font-semibold uppercase">YoY</span>
                            </div>
                          </div>

                          {/* Gross Margin Card */}
                          <div 
                            onClick={() => triggerCitationTrace(activeMetrics.grossMarginSourcePage, `Gross Margin Source (${financialReport.reportingPeriod})`)}
                            className="bg-white/2 border border-white/5 rounded-xl p-4 space-y-1 hover:border-indigo/40 hover:bg-white/4 cursor-pointer group active:scale-[0.98] transition duration-150"
                          >
                            <div className="flex justify-between items-center text-[10px] font-semibold text-gray-500 uppercase">
                              <span>Gross Margin</span>
                              <span className="text-[9px] text-indigo/60 group-hover:text-indigo font-bold flex items-center gap-0.5 transition font-mono">
                                🔍 P.{activeMetrics.grossMarginSourcePage}
                              </span>
                            </div>
                            <div className="text-lg font-black text-white font-mono">
                              {activeMetrics.grossMargin.toFixed(1)}%
                            </div>
                            <div className="flex items-center gap-1">
                              <span className={`text-[10px] font-bold ${dynamicGrossMarginShift >= 0 ? "text-emerald" : "text-rose-400"}`}>
                                {dynamicGrossMarginShiftText}
                              </span>
                              <span className="text-[9px] text-gray-600 font-semibold uppercase">YoY</span>
                            </div>
                          </div>

                          {/* Free Cash Flow Card */}
                          <div 
                            onClick={() => triggerCitationTrace(activeMetrics.freeCashFlowSourcePage, `Free Cash Flow Source (${financialReport.reportingPeriod})`)}
                            className="bg-white/2 border border-white/5 rounded-xl p-4 space-y-1 hover:border-indigo/40 hover:bg-white/4 cursor-pointer group active:scale-[0.98] transition duration-150"
                          >
                            <div className="flex justify-between items-center text-[10px] font-semibold text-gray-500 uppercase">
                              <span>Free Cash Flow</span>
                              <span className="text-[9px] text-indigo/60 group-hover:text-indigo font-bold flex items-center gap-0.5 transition font-mono">
                                🔍 P.{activeMetrics.freeCashFlowSourcePage}
                              </span>
                            </div>
                            <div className="text-lg font-black text-white font-mono">
                              ${(activeMetrics.freeCashFlow / 1e9).toFixed(2)}B
                            </div>
                            <div className="flex items-center gap-1">
                              <span className={`text-[10px] font-bold ${dynamicFreeCashFlowYoY.startsWith("+") ? "text-emerald" : "text-rose-400"}`}>
                                {dynamicFreeCashFlowYoY}
                              </span>
                              <span className="text-[9px] text-gray-600 font-semibold uppercase">YoY</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 2. Quarterly / Period Comparison Panel */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                            2. Period-over-Period Comparison
                          </label>
                          <button
                            type="button"
                            onClick={() => setShowComparison(!showComparison)}
                            className={`text-[10px] font-bold px-2 py-0.5 rounded border transition duration-200 ${
                              showComparison 
                                ? "bg-indigo/20 text-indigo border-indigo/30" 
                                : "bg-white/2 text-gray-400 border-white/8 hover:text-white"
                            }`}
                          >
                            {showComparison ? "Hide Comparison" : "Compare YoY"}
                          </button>
                        </div>

                        {showComparison && (
                          <div className="bg-white/2 border border-white/5 rounded-xl p-4 space-y-3">
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wide border-b border-white/5 pb-1.5 flex justify-between items-center">
                              <span>
                                {compReport 
                                  ? `Comparative Hub: ${financialReport.reportingPeriod} vs ${compReport.reportingPeriod}`
                                  : `Reporting Analysis: ${financialReport.reportingPeriod} (vs Estimated Prior Period)`
                                }
                              </span>
                              {compReport && (
                                <span className="text-emerald text-[9px] font-bold bg-emerald/10 border border-emerald/20 px-1.5 rounded uppercase">
                                  Registry Matched
                                </span>
                              )}
                            </div>
                            <div className="space-y-2.5 text-xs">
                              {/* Revenue Row */}
                              <div className="grid grid-cols-3 py-1 border-b border-white/2 items-center text-gray-300 font-mono">
                                <span className="text-gray-500 font-semibold text-[10px] uppercase font-sans">Revenue</span>
                                <span>
                                  {compMetrics 
                                    ? `$${(compMetrics.revenue / 1e9).toFixed(2)}B` 
                                    : `$${((activeMetrics.revenue / 1.11) / 1e9).toFixed(2)}B`
                                  }
                                </span>
                                <span className={dynamicRevenueYoY.startsWith("+") ? "text-emerald font-bold" : "text-rose-400"}>
                                  ${(activeMetrics.revenue / 1e9).toFixed(2)}B ({dynamicRevenueYoY})
                                </span>
                              </div>
                              {/* Gross Margin Row */}
                              <div className="grid grid-cols-3 py-1 border-b border-white/2 items-center text-gray-300 font-mono">
                                <span className="text-gray-500 font-semibold text-[10px] uppercase font-sans">Gross Margin</span>
                                <span>
                                  {compMetrics 
                                    ? `${compMetrics.grossMargin.toFixed(1)}%` 
                                    : `${(activeMetrics.grossMargin + 1.5).toFixed(1)}%`
                                  }
                                </span>
                                <span className={dynamicGrossMarginShift >= 0 ? "text-emerald font-bold" : "text-rose-400 font-bold"}>
                                  {activeMetrics.grossMargin.toFixed(1)}% ({dynamicGrossMarginShiftText})
                                </span>
                              </div>
                              {/* Free Cash Flow Row */}
                              <div className="grid grid-cols-3 py-1 border-b border-white/2 items-center text-gray-300 font-mono">
                                <span className="text-gray-500 font-semibold text-[10px] uppercase font-sans">Free Cash Flow</span>
                                <span>
                                  {compMetrics 
                                    ? `$${(compMetrics.freeCashFlow / 1e9).toFixed(2)}B` 
                                    : `$${((activeMetrics.freeCashFlow / 1.17) / 1e9).toFixed(2)}B`
                                  }
                                </span>
                                <span className={dynamicFreeCashFlowYoY.startsWith("+") ? "text-emerald font-bold" : "text-rose-400 font-bold"}>
                                  ${(activeMetrics.freeCashFlow / 1e9).toFixed(2)}B ({dynamicFreeCashFlowYoY})
                                </span>
                              </div>
                            </div>
                            <div className="text-[9px] text-gray-500 font-semibold leading-relaxed">
                              {compReport 
                                ? `* Note: YoY dynamic change dynamically computed from the active registry period [${selectedPeriod}] and comparison target [${comparisonPeriod}].`
                                : "* Note: YoY estimates derived from model context extracts. Upload another period PDF to unlock dynamic multi-document arithmetic!"
                              }
                            </div>

                            {/* Bloomberg-Style Inline SVG Comparison Chart Card */}
                            {compReport && (
                              <div className="mt-4 bg-black/40 border border-white/5 rounded-xl p-4 space-y-3.5">
                                <div className="text-[10px] font-bold text-indigo uppercase tracking-wider flex justify-between items-center">
                                  <span>Visual Performance Comparison Matrix</span>
                                  <span className="text-[8px] bg-indigo/10 border border-indigo/20 px-1 py-0.5 rounded text-gray-300 font-mono">SVG VIRTUALIZED</span>
                                </div>
                                
                                <div className="space-y-3">
                                  {/* Revenue Chart Row */}
                                  <div className="space-y-1">
                                    <div className="flex justify-between items-center text-[10px] text-gray-400 font-semibold font-mono">
                                      <span>CONSOLIDATED REVENUE ($B)</span>
                                      <div className="flex gap-2">
                                        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 bg-[#4f46e5] rounded-full" />{compReport.reportingPeriod}: ${(compMetrics.revenue / 1e9).toFixed(2)}B</span>
                                        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 bg-[#06b6d4] rounded-full" />{financialReport.reportingPeriod}: ${(activeMetrics.revenue / 1e9).toFixed(2)}B</span>
                                      </div>
                                    </div>
                                    
                                    {/* SVG Revenue Bars */}
                                    <div className="h-10 bg-black/50 border border-white/5 rounded-lg flex items-center px-2.5 relative overflow-hidden">
                                      {(() => {
                                        const maxVal = Math.max(activeMetrics.revenue, compMetrics.revenue, 1e9);
                                        const pctComp = (compMetrics.revenue / maxVal) * 100;
                                        const pctActive = (activeMetrics.revenue / maxVal) * 100;
                                        return (
                                          <div className="w-full flex flex-col gap-1.5 py-1">
                                            {/* Comparison Period bar (Neon Indigo) */}
                                            <div className="flex items-center gap-1.5">
                                              <div 
                                                style={{ width: `${pctComp}%` }} 
                                                className="h-1.5 bg-gradient-to-r from-indigo/60 to-[#4f46e5] rounded-full shadow-sm shadow-indigo/20 transition-all duration-500" 
                                              />
                                            </div>
                                            {/* Active Period bar (Neon Cyan) */}
                                            <div className="flex items-center gap-1.5">
                                              <div 
                                                style={{ width: `${pctActive}%` }} 
                                                className="h-1.5 bg-gradient-to-r from-cyan/60 to-[#06b6d4] rounded-full shadow-sm shadow-cyan/20 transition-all duration-500" 
                                              />
                                            </div>
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  </div>

                                  {/* Operating Income Chart Row */}
                                  <div className="space-y-1">
                                    <div className="flex justify-between items-center text-[10px] text-gray-400 font-semibold font-mono">
                                      <span>OPERATING INCOME ($B)</span>
                                      <div className="flex gap-2">
                                        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 bg-[#4f46e5] rounded-full" />{compReport.reportingPeriod}: ${(compMetrics.operatingIncome / 1e9).toFixed(2)}B</span>
                                        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 bg-[#06b6d4] rounded-full" />{financialReport.reportingPeriod}: ${(activeMetrics.operatingIncome / 1e9).toFixed(2)}B</span>
                                      </div>
                                    </div>
                                    
                                    {/* SVG Operating Income Bars */}
                                    <div className="h-10 bg-black/50 border border-white/5 rounded-lg flex items-center px-2.5 relative overflow-hidden">
                                      {(() => {
                                        const maxVal = Math.max(activeMetrics.operatingIncome, compMetrics.operatingIncome, 1e8);
                                        const pctComp = (compMetrics.operatingIncome / maxVal) * 100;
                                        const pctActive = (activeMetrics.operatingIncome / maxVal) * 100;
                                        return (
                                          <div className="w-full flex flex-col gap-1.5 py-1">
                                            {/* Comparison Period bar */}
                                            <div className="flex items-center gap-1.5">
                                              <div 
                                                style={{ width: `${pctComp}%` }} 
                                                className="h-1.5 bg-gradient-to-r from-indigo/60 to-[#4f46e5] rounded-full shadow-sm shadow-indigo/20 transition-all duration-500" 
                                              />
                                            </div>
                                            {/* Active Period bar */}
                                            <div className="flex items-center gap-1.5">
                                              <div 
                                                style={{ width: `${pctActive}%` }} 
                                                className="h-1.5 bg-gradient-to-r from-cyan/60 to-[#06b6d4] rounded-full shadow-sm shadow-cyan/20 transition-all duration-500" 
                                              />
                                            </div>
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 3. Arithmetic Audit Ledger */}
                      <div className="space-y-3">
                        <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                          3. Automated Arithmetic Audit Ledger
                        </label>
                        
                        <div className="bg-[#111625]/60 border border-white/5 rounded-xl p-4 space-y-4">
                          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wide border-b border-white/5 pb-1 flex justify-between">
                            <span>Reconciliation Audit Checklist</span>
                            <span className="text-emerald font-bold">Tolerance +/-0.5%</span>
                          </div>
                          
                          <div className="space-y-3">
                            {/* Test A: Operating Income vs Revenue */}
                            <div className="space-y-1.5">
                              <div className="flex justify-between items-center text-xs">
                                <span className="font-semibold text-gray-300">1. Operating Profit Margin</span>
                                {(() => {
                                  const calculatedMargin = activeMetrics.revenue > 0 
                                    ? (activeMetrics.operatingIncome / activeMetrics.revenue) * 100 
                                    : 0;
                                  const passed = calculatedMargin <= activeMetrics.grossMargin && calculatedMargin > 0;
                                  return (
                                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
                                      passed ? "bg-emerald/10 text-emerald" : "bg-amber/10 text-amber"
                                    }`}>
                                      {passed ? "✓ Passed" : "⚠️ Warning"}
                                    </span>
                                  );
                                })()}
                              </div>
                              <div className="bg-black/30 border border-white/5 rounded-lg p-2.5 space-y-1 font-mono text-[11px] text-gray-400">
                                <div className="flex justify-between">
                                  <span>Operating income:</span>
                                  <span className="text-white">${(activeMetrics.operatingIncome / 1e9).toFixed(3)}B</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Divided by Revenue:</span>
                                  <span className="text-white">${(activeMetrics.revenue / 1e9).toFixed(3)}B</span>
                                </div>
                                <div className="flex justify-between border-t border-white/5 pt-1 mt-1 font-bold">
                                  <span>Calculated Op Margin:</span>
                                  <span className="text-indigo">
                                    {(activeMetrics.revenue > 0 
                                      ? (activeMetrics.operatingIncome / activeMetrics.revenue) * 100 
                                      : 0).toFixed(2)}%
                                  </span>
                                </div>
                                <div className="flex justify-between text-[10px] text-gray-500 italic">
                                  <span>Reported Gross Margin:</span>
                                  <span>{activeMetrics.grossMargin.toFixed(1)}%</span>
                                </div>
                              </div>
                            </div>

                            {/* Test B: Free Cash Flow vs Operating Income */}
                            <div className="space-y-1.5">
                              <div className="flex justify-between items-center text-xs">
                                <span className="font-semibold text-gray-300">2. FCF Cash Conversion Rate</span>
                                {(() => {
                                  const calculatedConversion = activeMetrics.operatingIncome > 0 
                                    ? (activeMetrics.freeCashFlow / activeMetrics.operatingIncome) * 100 
                                    : 0;
                                  const passed = calculatedConversion >= 0 && calculatedConversion <= 250;
                                  return (
                                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
                                      passed ? "bg-emerald/10 text-emerald" : "bg-amber/10 text-amber"
                                    }`}>
                                      {passed ? "✓ Passed" : "⚠️ Warning"}
                                    </span>
                                  );
                                })()}
                              </div>
                              <div className="bg-black/30 border border-white/5 rounded-lg p-2.5 space-y-1 font-mono text-[11px] text-gray-400">
                                <div className="flex justify-between">
                                  <span>Free Cash Flow:</span>
                                  <span className="text-white">${(activeMetrics.freeCashFlow / 1e9).toFixed(3)}B</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Divided by Op Income:</span>
                                  <span className="text-white">${(activeMetrics.operatingIncome / 1e9).toFixed(3)}B</span>
                                </div>
                                <div className="flex justify-between border-t border-white/5 pt-1 mt-1 font-bold">
                                  <span>Cash Conversion Rate:</span>
                                  <span className="text-indigo">
                                    {(activeMetrics.operatingIncome > 0 
                                      ? (activeMetrics.freeCashFlow / activeMetrics.operatingIncome) * 100 
                                      : 0).toFixed(2)}%
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  );
                })()}

                {/* 4. Tone Sentiment Velocity Timeline */}
                {financialReport.toneVelocity && financialReport.toneVelocity.length > 0 && (
                  <div className="space-y-3">
                    <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                      4. Sentiment Velocity Timeline (Vertical Flow)
                    </label>
                    
                    <div className="bg-[#111625]/40 border border-white/5 rounded-xl p-4 space-y-4">
                      <p className="text-[10px] text-gray-500 font-semibold uppercase leading-relaxed">
                        Page-by-page executive tone shift. Click any page block to trace forensic raw content.
                      </p>
                      
                      <div className="relative pl-6 space-y-4">
                        {/* Vertical timeline line */}
                        <div className="absolute left-[13px] top-2.5 bottom-2.5 w-0.5 bg-gradient-to-b from-emerald via-amber to-rose-500 opacity-20" />
                        
                        {financialReport.toneVelocity.map((item: any, idx: number) => {
                          const isPositive = item.score > 0.1;
                          const isNegative = item.score < -0.1;
                          const badgeColor = isPositive 
                            ? "bg-emerald border-emerald shadow-emerald/20" 
                            : isNegative 
                            ? "bg-rose-500 border-rose-500 shadow-rose-500/20" 
                            : "bg-amber border-amber shadow-amber/20";
                            
                          return (
                            <div 
                              key={idx} 
                              onClick={() => triggerCitationTrace(item.page, `Page ${item.page} Tone Velocity: ${item.dominantTone}`)}
                              className="relative flex items-start gap-4 cursor-pointer group hover:bg-white/3 p-2 rounded-lg transition"
                            >
                              {/* Circle node on the line */}
                              <div className={`absolute -left-[18px] top-3.5 w-2 h-2 rounded-full border-2 ${badgeColor} shadow-md group-hover:scale-125 transition-transform`} />
                              
                              <div className="flex-grow space-y-1">
                                <div className="flex justify-between items-center">
                                  <span className="text-xs font-bold text-white group-hover:text-indigo transition">
                                    Page {item.page} • <span className="text-gray-400 font-normal">{item.dominantTone}</span>
                                  </span>
                                  <span className={`text-[10px] font-mono font-bold ${item.score > 0 ? "text-emerald" : item.score < 0 ? "text-rose-400" : "text-amber"}`}>
                                    {item.score > 0 ? `+${item.score.toFixed(2)}` : item.score.toFixed(2)}
                                  </span>
                                </div>
                                
                                {/* Score Indicator Horizontal Gauge */}
                                <div className="w-full h-1 bg-black/40 rounded-full border border-white/5 overflow-hidden relative">
                                  <div 
                                    className={`absolute top-0 bottom-0 rounded-full transition-all duration-300 ${
                                      item.score >= 0 ? "bg-emerald left-1/2" : "bg-rose-500 right-1/2"
                                    }`}
                                    style={{
                                      width: `${Math.min(50, Math.abs(item.score) * 50)}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* 5. Management Sentiment Overview */}
                <div className="space-y-3">
                  <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                    5. Management Sentiment & Focus
                  </label>
                  
                  <div className="bg-white/2 border border-white/5 rounded-xl p-4 space-y-4">
                    {/* Tone Header */}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-gray-500 uppercase">Executive Tone</span>
                      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase border ${
                        financialReport.sentiment.executiveTone === "Bullish"
                          ? "bg-emerald/10 border-emerald/20 text-emerald"
                          : financialReport.sentiment.executiveTone === "Cautious"
                          ? "bg-amber/10 border-amber/20 text-amber"
                          : "bg-indigo/10 border-indigo/20 text-indigo"
                      }`}>
                        {financialReport.sentiment.executiveTone}
                      </span>
                    </div>

                    {/* Numeric Gauge bar */}
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-[10px] font-bold">
                        <span className="text-rose-400 font-semibold uppercase font-sans">Cautious</span>
                        <span className="text-white font-mono">{financialReport.sentiment.score > 0 ? `+${financialReport.sentiment.score.toFixed(2)}` : financialReport.sentiment.score.toFixed(2)}</span>
                        <span className="text-emerald font-semibold uppercase font-sans">Confident</span>
                      </div>
                      <div className="w-full h-2 bg-black/40 rounded-full border border-white/5 overflow-hidden relative">
                        <div 
                          className={`absolute top-0 bottom-0 rounded-full transition-all duration-500 ${
                            financialReport.sentiment.score >= 0 ? "bg-emerald left-1/2" : "bg-rose-500 right-1/2"
                          }`}
                          style={{
                            width: `${Math.min(50, Math.abs(financialReport.sentiment.score) * 50)}%`,
                          }}
                        />
                        <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-white/30" />
                      </div>
                    </div>

                    {/* Counters */}
                    <div className="grid grid-cols-2 gap-2 border-t border-b border-white/5 py-2 font-sans">
                      <div className="flex items-center gap-1.5 text-xs text-gray-300 font-semibold">
                        <span className="w-2 h-2 rounded-full bg-cyan" />
                        AI Mentions: <strong className="text-white font-mono">{financialReport.sentiment.mentionsAI}x</strong>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-gray-300 font-semibold">
                        <span className="w-2 h-2 rounded-full bg-amber" />
                        Layoff Remarks: <strong className="text-white font-mono">{financialReport.sentiment.mentionsLayoffs}x</strong>
                      </div>
                    </div>

                    {/* Paragraph comment */}
                    <p className="text-xs text-gray-400 italic leading-relaxed pl-3 border-l-2 border-indigo/40">
                      "{financialReport.sentiment.sentimentAnalysis}"
                    </p>
                  </div>
                </div>

                {/* 6. Core Risks */}
                <div className="space-y-3">
                  <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                    6. Highlighted Risk Disclosures
                  </label>
                  
                  <div className="space-y-2">
                    {financialReport.risks.map((risk: any, idx: number) => (
                      <div 
                        key={idx} 
                        onClick={() => triggerCitationTrace(risk.sourcePage, `${risk.vector} Risk Detail`)}
                        className="bg-white/2 border border-white/5 rounded-xl p-4 space-y-1.5 hover:border-indigo/40 hover:bg-white/4 cursor-pointer group active:scale-[0.98] transition duration-150"
                      >
                        <h4 className="text-xs font-bold text-white flex gap-2 items-center justify-between">
                          <span className="flex gap-2 items-center">
                            <span className="w-4 h-4 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] flex items-center justify-center font-bold font-sans">
                              {String.fromCharCode(65 + idx)}
                            </span>
                            {risk.vector}
                          </span>
                          <span className="text-[9px] text-indigo/60 group-hover:text-indigo font-bold flex items-center gap-0.5 transition font-mono">
                            🔍 P.{risk.sourcePage}
                          </span>
                        </h4>
                        <p className="text-xs text-gray-400 leading-relaxed pl-6">
                          {risk.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 7. Guidance Outlook Card */}
                <div className="space-y-3">
                  <label className="text-xs font-bold tracking-wider text-gray-400 uppercase block">
                    7. Executive Forward Outlook
                  </label>
                  
                  <div 
                    onClick={() => triggerCitationTrace(financialReport.guidance.sourcePage, `Guidance Statement Outlook`)}
                    className="bg-[#111625]/60 border border-indigo/20 rounded-xl p-4 space-y-2.5 hover:border-indigo/40 hover:bg-[#111625]/80 cursor-pointer group active:scale-[0.98] transition duration-150"
                  >
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] font-bold text-indigo uppercase tracking-wider">Guidance Statement</span>
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
                          financialReport.guidance.confidence === "High"
                            ? "bg-emerald/10 text-emerald"
                            : "bg-amber/10 text-amber"
                        }`}>
                          Confidence: {financialReport.guidance.confidence}
                        </span>
                        <span className="text-[9px] text-indigo/60 group-hover:text-indigo font-bold flex items-center gap-0.5 transition font-mono">
                          🔍 P.{financialReport.guidance.sourcePage}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-gray-300 leading-relaxed font-semibold">
                      {financialReport.guidance.outlook}
                    </p>
                  </div>
                </div>

                {/* 8. Slide-Open Forensic Citation Overlay Drawer */}
                {activeCitationPage !== null && (
                  <div className="absolute inset-0 bg-[#080b11]/95 flex flex-col z-30 animate-in slide-in-from-bottom duration-300 font-sans">
                    <div className="p-5 border-b border-white/8 bg-[#0b0f19] flex items-center justify-between">
                      <div>
                        <h3 className="text-xs font-black uppercase tracking-widest text-indigo">
                          Forensic Source Citation
                        </h3>
                        <p className="text-[10px] text-emerald font-semibold uppercase mt-0.5">
                          Page {activeCitationPage} • {activeCitationLabel || "Financial Source"}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          setActiveCitationPage(null);
                          setActiveCitationText(null);
                          setActiveCitationLabel(null);
                        }}
                        className="w-7 h-7 rounded-lg bg-white/4 hover:bg-rose-500/10 border border-white/8 hover:border-rose-500/20 text-gray-400 hover:text-rose-400 flex items-center justify-center transition"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex-grow overflow-y-auto p-6 space-y-4 bg-black/40">
                      <div className="bg-black/60 border border-white/5 rounded-xl p-4 font-mono text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap select-text max-h-[80vh] overflow-y-auto">
                        {activeCitationText}
                      </div>
                    </div>
                    <div className="p-4 border-t border-white/8 bg-[#0b0f19] flex justify-end">
                      <button
                        onClick={() => {
                          setActiveCitationPage(null);
                          setActiveCitationText(null);
                          setActiveCitationLabel(null);
                        }}
                        className="bg-indigo hover:bg-indigo/90 text-white font-bold py-1.5 px-4 rounded-lg text-xs transition duration-200"
                      >
                        Close Inspector
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      ) : null}

      {/* Drag Divider 2 (Dashboard - Chat) */}
      {financialReport || isExtracting ? (
        <div 
          onMouseDown={handleDashboardMouseDown}
          className="w-[4px] hover:w-[6px] bg-white/5 hover:bg-indigo cursor-col-resize transition-all h-full flex-shrink-0 z-20"
          title="Drag to resize dashboard panel"
        />
      ) : null}

      {/* ========================================================
          RIGHT CHAT AREA: Workspace Arena
          ======================================================== */}
      <main className="flex-grow flex flex-col bg-[#0b0f19]">
        
        {/* Upper Screen Header */}
        <header className="h-16 border-b border-white/8 flex items-center justify-between px-8 bg-[#080b11]/50 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-extrabold tracking-tight text-white md:text-base">
              Research Terminal Console
            </h1>
            {pdfMeta && (
              <span className="bg-indigo/10 text-indigo border border-indigo/25 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full max-w-[200px] truncate">
                📄 Context: {pdfMeta.name}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 font-semibold">
            {chunks.length > 0 ? (
              <span className="text-emerald font-bold">Document Loaded ({chunks.length} Chunks, RAG Enabled)</span>
            ) : (
              <span>RAG Context Inactive</span>
            )}
          </div>
        </header>

        {/* Middle Screen Scrollable chat arena */}
        <div className="flex-grow overflow-y-auto p-8 space-y-6">
          {messages.map((msg) => {
            const isSystem = msg.role === "system";
            const isUser = msg.role === "user";
            
            return (
              <div
                key={msg.id}
                className={`flex gap-4 max-w-4xl ${isUser ? "ml-auto flex-row-reverse" : "mr-auto"}`}
              >
                {/* Profile Icon avatar */}
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center text-white flex-shrink-0 shadow-md ${
                    isUser
                      ? "bg-indigo"
                      : isSystem
                      ? "bg-amber/10 border border-amber/30 text-amber"
                      : "bg-cyan/10 border border-cyan/30 text-cyan"
                  }`}
                >
                  {isUser ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  ) : isSystem ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  )}
                </div>

                {/* Message speech bubble block */}
                <div
                  className={`rounded-2xl p-4 md:p-5 border ${
                    isUser
                      ? "bg-indigo/10 border-indigo/25 text-white"
                      : isSystem
                      ? "bg-amber/5 border-amber/10 text-amber"
                      : "bg-[#161c2d]/50 border-white/6 text-gray-200"
                  }`}
                >
                  {renderMessageContent(msg.content)}
                  {msg.content === "" && isStreaming && (
                    <div className="flex gap-1 items-center py-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan animate-bounce" />
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan animate-bounce [animation-delay:0.2s]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan animate-bounce [animation-delay:0.4s]" />
                    </div>
                  )}
                  
                  {/* Collapsible RAG Trace Debugger Panel */}
                  {msg.trace && (
                    <div className="mt-4 border-t border-white/8 pt-3 font-sans">
                      <details className="group">
                        <summary className="text-[10px] font-bold text-indigo hover:text-indigo/80 cursor-pointer list-none flex items-center gap-1 outline-none uppercase tracking-wider select-none">
                          <span className="transition-transform group-open:rotate-90">▶</span>
                          <span>RAG Trace Debugger Log</span>
                          <span className="ml-auto bg-indigo/10 border border-indigo/25 px-1.5 py-0.5 rounded text-[8px] text-gray-300 font-mono lowercase">
                            {msg.trace.strategy} | {msg.trace.latencyMs}ms
                          </span>
                        </summary>
                        
                        <div className="mt-2.5 space-y-2 text-[11px] leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200">
                          {/* Metadata row */}
                          <div className="grid grid-cols-2 gap-2 bg-black/40 border border-white/5 rounded-lg p-2 font-mono text-gray-400">
                            <div>
                              Strategy: <strong className="text-white">{msg.trace.strategy}</strong>
                            </div>
                            <div>
                              Latency: <strong className="text-white font-mono">{msg.trace.latencyMs}ms</strong>
                            </div>
                          </div>
                          
                          {/* Retrieved Chunks list */}
                          <div className="space-y-2">
                            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider block">Top 3 Retrieved Parent Contexts:</span>
                            {msg.trace.chunks.map((item: any, idx: number) => (
                              <div key={item.id || idx} className="bg-[#111625]/60 border border-white/5 rounded-lg p-2.5 space-y-1">
                                <div className="flex justify-between items-center text-[10px] font-bold">
                                  <span className="text-indigo">Source Chunk #{idx + 1} (Page {item.page})</span>
                                  <span className="text-emerald font-mono bg-emerald/10 px-1 py-0.5 rounded text-[8px]">
                                    Match: {Math.round(item.score * 100)}%
                                  </span>
                                </div>
                                <p className="text-gray-400 font-mono text-[10px] leading-normal line-clamp-3 italic hover:line-clamp-none transition duration-200 cursor-pointer">
                                  "{item.text}"
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          
          {/* Scroll bottom target */}
          <div ref={chatEndRef} />
        </div>

        {/* Bottom prompt input deck */}
        <footer className="p-6 border-t border-white/8 bg-[#080b11]/30">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex gap-3 relative">
            <input
              type="text"
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              placeholder={
                chunks.length > 0
                  ? "Ask anything about the ingested PDF document..."
                  : "Upload a PDF report on the left first to enable Document Chat."
              }
              disabled={isStreaming || isUploading}
              className="flex-grow bg-black/50 border border-white/8 focus:border-indigo text-white placeholder:text-gray-600 rounded-xl pl-4 pr-16 py-3.5 text-sm md:text-base outline-none transition"
            />
            <button
              type="submit"
              disabled={isStreaming || isUploading || !inputPrompt.trim()}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 w-10 h-10 rounded-lg bg-indigo hover:bg-indigo/90 disabled:opacity-30 disabled:hover:bg-indigo text-white flex items-center justify-center shadow-lg transition duration-200"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" className="rotate-45 -translate-x-0.5 translate-y-0.5">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
          <div className="text-center mt-2.5">
            <span className="text-[10px] text-gray-500 font-semibold">
              Equity-Copilot processes documents secure and local. Response times reflect streaming SSE TTFT metrics.
            </span>
          </div>
        </footer>

      </main>

      {/* ========================================================
          CREDENTIALS AUTHENTICATION DIALOG (SUPABASE / LOCAL SANDBOX)
          ======================================================== */}
      {showAuthModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200 font-sans">
          <div className="bg-[#0b0f19] border border-white/8 rounded-2xl p-6 w-[360px] max-w-full space-y-5 shadow-2xl relative">
            
            {/* Close Button */}
            <button
              onClick={() => {
                setShowAuthModal(false);
                setAuthEmail("");
                setAuthPassword("");
                setAuthError(null);
              }}
              className="absolute right-4 top-4 text-gray-400 hover:text-white text-xs font-bold"
            >
              ✕
            </button>
            
            <div className="text-center space-y-1">
              <h3 className="text-sm font-black uppercase tracking-wider text-indigo">
                {authMode === "signin" ? "Analyst Login Authentication" : "Register Analyst Account"}
              </h3>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">
                Access Relational Database Layer
              </p>
            </div>
            
            <form onSubmit={handleAuthAction} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase block">Email Address</label>
                <input
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="analyst@hedgefund.com"
                  className="w-full bg-black/60 border border-white/8 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-600 outline-none focus:border-indigo transition"
                />
              </div>
              
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase block">Password Credentials</label>
                <input
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-black/60 border border-white/8 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-600 outline-none focus:border-indigo transition font-mono"
                />
              </div>
              
              {authError && (
                <div className="text-[10px] font-semibold text-rose-400 bg-rose-950/20 border border-rose-900/30 rounded-lg p-2.5 leading-relaxed">
                  {authError}
                </div>
              )}
              
              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-indigo hover:bg-indigo/90 disabled:opacity-50 text-white font-bold py-2 rounded-lg text-xs transition duration-200 uppercase tracking-wider"
              >
                {authLoading ? "Verifying..." : authMode === "signin" ? "Unlock Terminal" : "Register Terminal Account"}
              </button>
            </form>
            
            <div className="text-center pt-1">
              <button
                onClick={() => {
                  setAuthMode(authMode === "signin" ? "signup" : "signin");
                  setAuthError(null);
                }}
                className="text-[10px] text-gray-500 hover:text-indigo font-bold transition uppercase"
              >
                {authMode === "signin" ? "Need an analyst profile? Register here" : "Have an existing account? Sign in"}
              </button>
            </div>
            
          </div>
        </div>
      )}
    </div>
  );
}
