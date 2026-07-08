# Roundcube Agent AI

Roundcube Agent AI is a serverless, locally executing browser extension that brings autonomous data-extraction capabilities to your IITB webmail client. Operating securely within a Chrome side panel, it interfaces directly with your inbox DOM to process emails and synthesize answers via large language models. The agent automates pagination, parses complex email structures, and handles natural language queries without relying on an external backend.

## Product Overview

![Screenshot 1 Placeholder: Main Chat Interface](assets/ss1.png)

![Screenshot 2 Placeholder: Scraping Progress](assets/ss2.png)

![Screenshot 3 Placeholder: Formatted LLM Response](assets/ss3.png)

## Usage Guidelines

1. **Install the Extension:** Load the provided folder as an unpacked extension in your Chrome browser (`chrome://extensions/`).
2. **Open Roundcube:** Navigate to your Roundcube webmail interface and ensure you are logged in.
3. **Launch the Agent:** Click the extension icon to open the side panel. 
4. **Configure API Access:** Obtain a free API key from OpenRouter. Paste the key into the configuration bar at the top of the side panel and click "Save".
5. **Ask Queries:** Type conversational requests into the input box (e.g., "Summarize the first 10 emails," or "What did John send regarding the meeting?"). The agent will automatically scrape the necessary emails, read the contents, and provide a direct answer.

![Screenshot 4 Placeholder: OpenRouter API Setup](assets/ss4.png)

## Architecture & Agentic Workflow

This extension is built on a serverless, agentic orchestration framework powered by LangGraph.js, operating entirely within the client's browser environment. 

### Core Components
- **The Orchestrator:** The primary routing node that interprets raw user intent. By determining whether the user requires generic conversation or explicit data extraction, the Orchestrator safely restricts the agent's scope and formulates a precise scraping plan (including target pagination boundaries).
- **The DOM Scraper:** A robust content script acting as a specialized data pipe. Upon receiving execution commands from the Orchestrator, it interfaces with the Roundcube DOM. It handles asynchronous page loads, strips heavy HTML/CSS structures, and formats the raw inbox data into token-efficient JSON arrays. A local memory caching system is built-in to prevent redundant DOM scraping on consecutive queries for the same email ranges.
- **The Structured Synthesizer:** An analytical evaluation node that receives the standardized JSON output. Using strict structural prompting, it isolates relevant context to answer the user query. The node is explicitly constrained to avoid hallucination, utilizing a boolean fallback if the requested data is not present in the ingested context window.

### Resiliency and Edge Cases
Because the system runs locally and utilizes free-tier LLM endpoints (via OpenRouter), it features multi-layered resilience strategies. Malformed JSON outputs from highly constrained models trigger a regex-based extraction fallback, followed by an automatic retry loop that forces a model reallocation. This ensures uninterrupted execution without compromising on response structure or user experience.
