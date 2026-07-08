// This runs in your Chrome Extension Content Script

async function fetchEmailBody(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return "Failed to load body";
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const bodyElement = doc.querySelector('#messagebody');
        if (bodyElement) {
            // Get text content, replacing line breaks with spaces to save tokens
            return bodyElement.innerText.replace(/\s+/g, ' ').trim();
        }
        return "No body content found (could not find #messagebody in HTML)";
    } catch (e) {
        console.error(`[Roundcube Agent] Error fetching body for ${url}:`, e);
        return "Error fetching body: " + e.message;
    }
}

async function extractRoundcubeEmails(targetIndexRange = null) {
    console.log("[Roundcube Agent] Starting extractRoundcubeEmails() with range:", targetIndexRange);
    let extractedEmails = [];
    
    // In Roundcube, emails are usually rows in a table with ID 'messagelist'
    let emailRows = document.querySelectorAll('#messagelist tbody tr'); 
    
    // Filter out rows to a maximum of 50
    let rowsToProcess = Array.from(emailRows).slice(0, 50);
    
    let basicEmails = [];

    console.log(`[Roundcube Agent] Found ${rowsToProcess.length} rows to process.`);

    // Extract basic fields and the URL for the body
    rowsToProcess.forEach((row, index) => {
        // Find the main subject link - usually has class 'subject' or contains a link
        let aTag = row.querySelector('td.subject a, a[href*="_action=show"], .subject a');
        let subject = aTag ? aTag.innerText.trim() : "No Subject";
        let url = aTag ? aTag.href : null;
        let sender = row.querySelector('.fromto, .rcmContactAddress')?.innerText.trim() || "Unknown";
        let date = row.querySelector('.date')?.innerText.trim() || "Unknown date";
        
        // Ensure absolute URL
        if (url && url.startsWith('./')) {
            url = new URL(url, window.location.href).href;
        }

        basicEmails.push({
            id: index,
            sender: sender,
            subject: subject,
            date: date,
            url: url
        });
    });

    console.log(`[Roundcube Agent] Extracted ${basicEmails.length} basic emails. Beginning batch deep scraping.`);

    // Batch process fetching email bodies
    const BATCH_SIZE = 10;
    for (let i = 0; i < basicEmails.length; i += BATCH_SIZE) {
        const batch = basicEmails.slice(i, i + BATCH_SIZE);
        
        // Notify the side panel about progress
        chrome.runtime.sendMessage({ 
            type: 'SCRAPE_PROGRESS', 
            text: `Deep scraping emails ${i + 1} to ${Math.min(i + BATCH_SIZE, basicEmails.length)} of ${basicEmails.length}...`
        });

        // Fetch the bodies for this batch concurrently
        const bodyPromises = batch.map(async (email) => {
            let bodyText = "Body not fetched (outside target range)";
            
            let shouldFetch = true;
            if (targetIndexRange && Array.isArray(targetIndexRange) && targetIndexRange.length === 2) {
                if (email.id < targetIndexRange[0] || email.id >= targetIndexRange[1]) {
                    shouldFetch = false;
                }
            }

            if (shouldFetch && email.url) {
                bodyText = await fetchEmailBody(email.url);
            }
            
            return {
                id: email.id,
                sender: email.sender,
                subject: email.subject,
                date: email.date,
                bodySnippet: bodyText.substring(0, 500) // limit body size to save tokens/context if needed, though Gemini can handle it. Let's send up to 2000 chars.
            };
        });

        const completedBatch = await Promise.all(bodyPromises);
        
        // Update bodySnippet length to something reasonable to avoid exceeding limits while still providing context
        completedBatch.forEach(e => {
             e.bodySnippet = e.bodySnippet.substring(0, 2000); 
        });

        extractedEmails.push(...completedBatch);
    }

    // Check if there's a next page button that is not disabled
    let hasNextPage = false;
    let nextBtn = document.querySelector('.button.nextpage, a.nextpage, #rcmbtn121, #rcmbtn108'); // Common Roundcube next buttons
    if (nextBtn && !nextBtn.classList.contains('disabled')) {
        hasNextPage = true;
    }

    return { emails: extractedEmails, hasNextPage: hasNextPage };
}

function clickNextPageAndWait() {
    return new Promise((resolve, reject) => {
        let nextBtn = document.querySelector('.button.nextpage, a.nextpage, #rcmbtn121, #rcmbtn108');
        if (!nextBtn || nextBtn.classList.contains('disabled')) {
            resolve(false);
            return;
        }

        const messageList = document.querySelector('#messagelist tbody');
        if (!messageList) {
            reject("Could not find message list to observe");
            return;
        }

        // Set up observer to wait for DOM changes (new emails loaded)
        const observer = new MutationObserver((mutations, obs) => {
            obs.disconnect(); // Stop observing once we see a change
            setTimeout(() => resolve(true), 200); // Small buffer to ensure rendering is complete
        });

        observer.observe(messageList, { childList: true, subtree: true });

        // Trigger the click
        nextBtn.click();
        
        // Fallback timeout in case observer doesn't fire (e.g. network error)
        setTimeout(() => {
            observer.disconnect();
            resolve(true); 
        }, 5000);
    });
}

// Listen for messages from LangGraph agent
console.log("[Roundcube Agent] Content script loaded.");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("[Roundcube Agent] Received message:", request);
    if (request.action === 'SCRAPE_EMAILS') {
        const { targetPage, targetIndexRange } = request;
        
        if (targetPage === 1) {
            // Scrape current view immediately
            console.log("[Roundcube Agent] Scraping target page 1 with range:", targetIndexRange);
            extractRoundcubeEmails(targetIndexRange).then(result => {
                console.log("[Roundcube Agent] Scraping completed:", result);
                sendResponse({ success: true, ...result });
            }).catch(err => {
                console.error("[Roundcube Agent] Scraping error:", err);
                sendResponse({ success: false, error: err.toString() });
            });
        } else {
            // Need to paginate first
            chrome.runtime.sendMessage({ type: 'SCRAPE_PROGRESS', text: `Navigating to page ${targetPage}...` });
            clickNextPageAndWait().then(navigated => {
                if (navigated) {
                    extractRoundcubeEmails(targetIndexRange).then(result => {
                        sendResponse({ success: true, ...result });
                    }).catch(err => {
                        sendResponse({ success: false, error: err.toString() });
                    });
                } else {
                    sendResponse({ success: false, error: "Could not navigate to next page" });
                }
            }).catch(err => {
                sendResponse({ success: false, error: err.toString() });
            });
        }
        return true; // Keep message channel open for async response
    }
});
