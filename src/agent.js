import { StateGraph, START, END, Annotation } from '@langchain/langgraph';

// 1. Define State
const StateAnnotation = Annotation.Root({
    user_query: Annotation(),
    action: Annotation({
        reducer: (curr, next) => next,
        default: () => "scrape"
    }),
    target_index_range: Annotation({
        reducer: (curr, next) => next,
        default: () => null
    }),
    current_page: Annotation({
        reducer: (curr, next) => next,
        default: () => 1
    }),
    max_pages: Annotation({
        reducer: (curr, next) => next,
        default: () => 2
    }),
    has_next_page: Annotation({
        reducer: (curr, next) => next,
        default: () => true
    }),
    scraped_emails: Annotation({
        reducer: (curr, next) => [...curr, ...next],
        default: () => []
    }),
    found_answer: Annotation({
        reducer: (curr, next) => next,
        default: () => false
    }),
    final_answer: Annotation({
        reducer: (curr, next) => next,
        default: () => ""
    }),
    dom_error: Annotation({
        reducer: (curr, next) => next,
        default: () => false
    })
});

// 2. Define Nodes

async function orchestratorNode(state) {
    console.log("[Node] orchestratorNode starting...");
    updateUI("Planning agent actions...", true);
    
    const apiKey = localStorage.getItem('openRouterApiKey');
    if (!apiKey) {
        return { dom_error: true, final_answer: "Please enter your OpenRouter API Key in the settings above." };
    }

    const systemPrompt = `You are the Orchestrator Agent for a webmail assistant. Decide the best action based on the user's query.
- If the user is just saying hello, asking a general question unrelated to their inbox, or chatting, set "action": "chat" and provide a "response".
- If the user asks about specific emails (e.g., "first 10 emails", "emails 20-30"), set "action": "scrape" and specify the "target_index_range" array [start, end]. Note that each page has 50 emails. So "emails 10-20" means [10, 20].
- If they ask a general search query (e.g., "what did joglekar send", "find event details"), set "action": "scrape", and "target_index_range": null (to scrape all emails on the page).

Output ONLY valid JSON matching this schema:
{
  "action": "chat" | "scrape",
  "response": "string, only if action is chat",
  "pages_to_scrape": 1,
  "target_index_range": [start, end] | null
}`;

    try {
        const res = await fetch(`https://openrouter.ai/api/v1/chat/completions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/roundcube-agent',
                'X-Title': 'Roundcube Agent'
            },
            body: JSON.stringify({
                model: 'openrouter/free',
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: "Query: " + state.user_query }
                ]
            })
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            if (res.status === 429) return { dom_error: true, final_answer: "API Limit Reached! You have exhausted your OpenRouter API limits." };
            if (res.status === 401 || res.status === 403) return { dom_error: true, final_answer: "Invalid API Key! Please check your OpenRouter API key." };
            return { dom_error: true, final_answer: `API Error (${res.status}): ${errorData.error?.message || res.statusText}` };
        }

        const data = await res.json();
        const textContent = data.choices[0].message.content;
        if (!textContent) throw new Error("Empty response from model: " + JSON.stringify(data));
        
        let parsed;
        try {
            parsed = JSON.parse(textContent.trim());
        } catch (e) {
            const match = textContent.match(/```(?:json)?([\s\S]*?)```/);
            try {
                if (match) parsed = JSON.parse(match[1].trim());
                else throw new Error("No markdown");
            } catch (err) {
                console.warn("Using regex fallback for Orchestrator due to malformed JSON.");
                const actionMatch = textContent.match(/"action"\s*:\s*"([^"]+)"/);
                const rangeMatch = textContent.match(/"target_index_range"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
                const pagesMatch = textContent.match(/"pages_to_scrape"\s*:\s*(\d+)/);
                if (actionMatch) {
                    parsed = {
                        action: actionMatch[1],
                        target_index_range: rangeMatch ? [parseInt(rangeMatch[1]), parseInt(rangeMatch[2])] : null,
                        pages_to_scrape: pagesMatch ? parseInt(pagesMatch[1]) : 1
                    };
                } else {
                    throw new Error("Model did not return valid JSON: " + textContent);
                }
            }
        }
        
        console.log("Orchestrator plan:", parsed);

        if (parsed.action === "chat") {
            return { action: "chat", found_answer: true, final_answer: parsed.response || "" };
        }

        return {
            action: parsed.action,
            max_pages: parsed.pages_to_scrape || 2,
            target_index_range: parsed.target_index_range || null
        };
    } catch (e) {
        console.error("Orchestrator Exception:", e);
        return { dom_error: true, final_answer: "Failed to contact OpenRouter Orchestrator: " + e.message };
    }
}

async function domScraperNode(state) {
    console.log("[Node] domScraperNode starting for page:", state.current_page);
    updateUI("Initializing page " + state.current_page + " scrape...", true);
    
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
        console.error("No active tab found");
        return { dom_error: true, final_answer: "Could not find active tab." };
    }
    console.log("Found active tab:", tab.id, tab.url);

    try {
        // Send message to content script
        const response = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { 
                action: 'SCRAPE_EMAILS', 
                targetPage: state.current_page,
                targetIndexRange: state.target_index_range
            }, resolve);
        });

        if (chrome.runtime.lastError || !response) {
            console.error("Message error:", chrome.runtime.lastError);
            return { dom_error: true, final_answer: "Ensure you are on the Roundcube page and refresh." };
        }

        console.log("Received response from content script:", response);

        if (!response.success) {
            return { dom_error: true, final_answer: "Scraping error: " + response.error };
        }

        return {
            scraped_emails: response.emails,
            has_next_page: response.hasNextPage
        };

    } catch (e) {
        return { dom_error: true, final_answer: "Exception during scraping: " + e.message };
    }
}

async function synthesizerNode(state) {
    if (state.dom_error) {
        console.log("Skipping synthesizer because of dom_error");
        return {};
    }
    
    console.log("[Node] synthesizerNode starting with emails count:", state.scraped_emails.length);
    updateUI("Synthesizing data from " + state.scraped_emails.length + " emails...", true);
    
    const apiKey = localStorage.getItem('openRouterApiKey');
    if (!apiKey) {
        return { dom_error: true, final_answer: "Please enter your OpenRouter API Key in the settings above." };
    }

    const systemPrompt = `You are an exact data-extraction agent. Review the provided webmail JSON data to answer the user's query.
RULES:
1. ONLY use the provided JSON. Do not guess.
2. If the answer is present, format it clearly using Markdown.
3. If the answer is NOT in the provided emails, do not apologize. Simply set the 'found' flag to false.

Respond ONLY with valid JSON matching this schema:
{
  "found": boolean,
  "answer": "markdown string"
}`;

    const userPrompt = `Query: ${state.user_query}\n\nEmails JSON:\n${JSON.stringify(state.scraped_emails, null, 2)}`;

    try {
        const res = await fetch(`https://openrouter.ai/api/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/roundcube-agent',
                'X-Title': 'Roundcube Agent'
            },
            body: JSON.stringify({
                model: 'openrouter/free',
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ]
            })
        });

        console.log("OpenRouter API response status:", res.status);

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            if (res.status === 429) {
                return { dom_error: true, final_answer: "API Limit Reached! You have exhausted your OpenRouter API limits." };
            }
            if (res.status === 401 || res.status === 403) {
                 return { dom_error: true, final_answer: "Invalid API Key! Please check your OpenRouter API key." };
            }
            return { dom_error: true, final_answer: `API Error (${res.status}): ${errorData.error?.message || res.statusText}` };
        }

        const data = await res.json();
        
        if (data.error) {
            return { dom_error: true, final_answer: "API Error: " + data.error.message };
        }

        const textContent = data.choices[0].message.content;
        if (!textContent) throw new Error("Empty response from model: " + JSON.stringify(data));

        let parsed;
        try {
            parsed = JSON.parse(textContent.trim());
        } catch (e) {
            const match = textContent.match(/```(?:json)?([\s\S]*?)```/);
            try {
                if (match) parsed = JSON.parse(match[1].trim());
                else throw new Error("No markdown");
            } catch (err) {
                console.warn("Using regex fallback for Synthesizer due to malformed JSON.");
                const foundMatch = textContent.match(/"found"\s*:\s*(true|false)/);
                let answerText = "";
                const answerMatch = textContent.match(/"answer"\s*:\s*"([\s\S]*?)"\s*\}/);
                if (answerMatch) answerText = answerMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                
                if (foundMatch) {
                    parsed = {
                        found: foundMatch[1] === "true",
                        answer: answerText
                    };
                } else {
                    throw new Error("Model did not return valid JSON: " + textContent);
                }
            }
        }
        
        console.log("Parsed OpenRouter response:", parsed);

        return {
            found_answer: parsed.found,
            final_answer: parsed.answer
        };
    } catch (e) {
        console.error("Synthesizer Exception:", e);
        return { dom_error: true, final_answer: "Failed to contact OpenRouter API: " + e.message };
    }
}

// 3. Define Graph Routing Logic
function routeAfterOrchestrator(state) {
    if (state.action === "chat" || state.dom_error) {
        return END;
    }
    return "domScraper";
}

function routeAfterSynthesis(state) {
    if (state.found_answer || state.dom_error) {
        return END;
    }
    
    if (!state.found_answer && state.current_page < state.max_pages && state.has_next_page) {
        return "domScraper";
    }
    
    return END;
}

// 4. Build Graph
const workflow = new StateGraph(StateAnnotation)
    .addNode("orchestrator", orchestratorNode)
    .addNode("domScraper", domScraperNode)
    .addNode("synthesizer", synthesizerNode)
    .addEdge(START, "orchestrator")
    .addConditionalEdges("orchestrator", routeAfterOrchestrator)
    .addEdge("domScraper", "synthesizer")
    .addConditionalEdges("synthesizer", routeAfterSynthesis);

const app = workflow.compile();


// --- UI Integration ---

const chatHistory = document.getElementById('chatHistory');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const loadingIndicator = document.getElementById('loadingIndicator');
const loadingText = document.getElementById('loadingText');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKeyBtn');

// Load API Key
const savedKey = localStorage.getItem('openRouterApiKey');
if (savedKey) apiKeyInput.value = savedKey;

saveKeyBtn.addEventListener('click', () => {
    localStorage.setItem('openRouterApiKey', apiKeyInput.value);
    saveKeyBtn.textContent = 'Saved!';
    setTimeout(() => saveKeyBtn.textContent = 'Save', 2000);
});

function addMessage(role, text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    let htmlText = text.replace(/\n/g, '<br>');
    contentDiv.innerHTML = htmlText;
    
    msgDiv.appendChild(contentDiv);
    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function updateUI(text, isLoading) {
    if (isLoading) {
        loadingIndicator.style.display = 'flex';
        loadingText.textContent = text;
    } else {
        loadingIndicator.style.display = 'none';
    }
}

// Listen for progress updates from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'SCRAPE_PROGRESS') {
        updateUI(request.text, true);
    }
});

async function handleSend() {
    const query = userInput.value.trim();
    if (!query) return;

    addMessage('user', query);
    userInput.value = '';
    userInput.disabled = true;
    sendBtn.disabled = true;

    console.log("--- Starting handleSend for query:", query, "---");

    try {
        console.log("Invoking LangGraph app...");
        const finalState = await app.invoke({
            user_query: query,
            current_page: 1,
            scraped_emails: []
        });
        
        console.log("LangGraph finished with state:", finalState);

        if (finalState.dom_error) {
            addMessage('system', "❌ " + finalState.final_answer);
        } else if (finalState.found_answer) {
            addMessage('system', finalState.final_answer);
        } else {
            addMessage('system', "I looked through the most recent emails but couldn't find anything about that.");
        }
    } catch (e) {
        console.error("Exception in handleSend execution:", e);
        addMessage('system', "System error: " + e.message);
    } finally {
        updateUI("", false);
        userInput.disabled = false;
        sendBtn.disabled = false;
        userInput.focus();
    }
}

sendBtn.addEventListener('click', handleSend);
userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSend();
});
