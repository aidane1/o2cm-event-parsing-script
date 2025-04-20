import axios from "axios";
import { load } from "cheerio";
import promptSync from "prompt-sync";
import qs from "querystring";
import chalk from "chalk";
import fs from "fs";

const prompt = promptSync();
const BASE_URL = "https://entries.o2cm.com/";
const ENTRIES_ENDPOINT = "default.asp"; // Endpoint for both GET and POST

// --- 1. Get User Input ---
function getEventIdFromUser() {
    return prompt("Enter the o2cm event ID (e.g CCC): ");
}

// --- 2. Fetch Initial Competitor IDs ---
async function fetchCompetitorIds(o2cmEvent) {
    const initialUrl = `${BASE_URL}?event=${o2cmEvent}`;
    console.log(`Workspaceing initial competitor list from: ${initialUrl}`);
    try {
        const response = await axios.get(initialUrl);
        const $ = load(response.data);
        const selectElement = $("#selEnt");

        if (!selectElement.length) {
            throw new Error('Could not find <select id="selEnt"> on the page.');
        }

        const competitorIds = selectElement
            .find("option")
            .map((i, el) => $(el).attr("value"))
            .get()
            .filter((val) => val && val.trim() !== ""); // Filter out empty values

        if (competitorIds.length === 0) {
            throw new Error("No valid competitor IDs found in the dropdown.");
        }

        console.log(`Found ${competitorIds.length} potential competitor entries.`);
        return competitorIds;
    } catch (error) {
        console.error(
            `Error fetching competitor IDs for event ${o2cmEvent}:`,
            error.message
        );
        throw error; // Re-throw to stop execution in main
    }
}

// --- 3. Fetch Individual Competitor Data ---
async function fetchCompetitorData(o2cmEvent, competitorId) {
    console.log(`Processing competitor ID: ${competitorId}`);
    const postUrl = `${BASE_URL}${ENTRIES_ENDPOINT}`;
    const formData = qs.stringify({
        submit: "OK",
        selEnt: competitorId,
        event: o2cmEvent,
    });

    try {
        const response = await axios.post(postUrl, formData, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
        });

        // Parse the HTML response to get structured data
        return parseCompetitorDataTable(response.data);
    } catch (error) {
        console.error(
            `Error fetching data for competitor ID ${competitorId}:`,
            error.message
        );
        // Decide if you want to return empty or re-throw
        return []; // Return empty array on error for this competitor
    }
}

// --- 4. Parse Competitor Details Table ---
function parseCompetitorDataTable(htmlContent) {
    const $ = load(htmlContent);
    const tables = $("table");
    const extractedEntries = [];

    if (tables.length < 2) {
        // console.warn("Expected at least 2 tables, found less. Skipping parsing for this entry.");
        return extractedEntries; // Return empty if structure is not as expected
    }

    const table = tables.eq(1); // Target the second table
    const rows = table.find("tr");

    if (rows.length < 2) {
        // console.warn("Competitor details table has less than 2 rows. Skipping parsing.");
        return extractedEntries; // Need at least header and one data row
    }

    // First data row usually contains the main competitor's name
    const competitorName = rows.eq(1).find("td").eq(0).text().trim();
    if (!competitorName) {
        console.warn("Could not parse competitor name from table row 1. Skipping.");
        return extractedEntries;
    }

    let currentPartnerName = "";
    let currentEvents = [];

    // Start from the third row (index 2) to find partners and events
    for (let i = 2; i < rows.length; i++) {
        const tds = rows.eq(i).find("td");

        // Check for a partner row (typically 2 columns: empty, 'With: Partner Name')
        if (tds.length === 2) {
            // If we were tracking events for a previous partner, save that block first
            if (currentPartnerName && currentEvents.length > 0) {
                extractedEntries.push({
                    competitorName: competitorName, // Use the consistent name from row 1
                    partnerName: currentPartnerName,
                    events: [...currentEvents], // Copy events array
                });
            }

            // Parse the new partner name
            let rawPartner = tds.eq(1).text().trim();
            if (rawPartner.toLowerCase().startsWith("with:")) {
                rawPartner = rawPartner.slice(5).trim(); // Remove "With: " prefix
            }
            // Attempt to format as "First Last" if comma-separated "Last, First"
            const nameParts = rawPartner.split(",").map((s) => s.trim());
            currentPartnerName =
                nameParts.length === 2 && nameParts[0] && nameParts[1]
                    ? `${nameParts[1]} ${nameParts[0]}`
                    : rawPartner; // Fallback to raw name if not "Last, First"

            currentEvents = []; // Reset events for the new partner
        }
        // Check for an event row (typically 3 columns: empty, empty, '[ID] Time Event Name')
        else if (tds.length === 3) {
            const rawEvent = tds.eq(2).text().trim();
            // Try to extract ID and Name cleanly
            const match = rawEvent.match(
                /^\[(\d+)\].*?\d{1,2}:\d{2} (?:AM|PM)\s+(.*)$/
            );
            if (match) {
                const [, id, name] = match;
                currentEvents.push({ id: parseInt(id, 10), name: name.trim() });
            } else {
                // Fallback if regex doesn't match - might miss ID
                currentEvents.push({ id: null, name: rawEvent });
            }
        }
    }

    // Save the last partner block after the loop finishes
    if (currentPartnerName && currentEvents.length > 0) {
        extractedEntries.push({
            competitorName: competitorName,
            partnerName: currentPartnerName,
            events: [...currentEvents],
        });
    }

    return extractedEntries;
}

// --- 5. Deduplicate Partnership Entries ---
function deduplicateEntries(results) {
    const uniqueEntries = new Map(); // Using a Map for efficient lookup

    for (const entry of results) {
        // Create a consistent key for the partnership, regardless of which partner was fetched
        // Sort names alphabetically to ensure (A, B) and (B, A) produce the same key
        const key = [entry.competitorName, entry.partnerName].sort().join("|");

        if (!uniqueEntries.has(key)) {
            // If this partnership hasn't been seen, add it
            uniqueEntries.set(key, entry);
        } else {
            // If partnership exists, potentially merge events (though typically they should be identical)
            // For simplicity here, we just keep the first one encountered.
            // If merging is needed, logic to combine event lists would go here.
        }
    }

    console.log(
        `Found ${results.length} raw entries, deduplicated to ${uniqueEntries.size} unique partnerships.`
    );
    return Array.from(uniqueEntries.values()); // Convert Map values back to an array
}

// --- 6. Group Results by Event ---
function groupResultsByEvent(deduplicatedResults) {
    const eventsMap = {}; // Key: eventId, Value: { eventName, couples: [[partner1, partner2], ...] }

    deduplicatedResults.forEach(({ competitorName, partnerName, events }) => {
        events.forEach(({ id, name }) => {
            // Use a fallback ID if parsing failed
            const eventId = id ?? `unknown_${name.replace(/\s+/g, "_")}`;

            if (!eventsMap[eventId]) {
                eventsMap[eventId] = {
                    eventName: name, // Store the name with the event
                    couples: [],
                };
            }
            // Add the couple to this events list
            // Ensure we don't add duplicate couples *within* the same event if data is messy
            if (
                !eventsMap[eventId].couples.some(
                    (c) =>
                        (c[0] === competitorName && c[1] === partnerName) ||
                        (c[0] === partnerName && c[1] === competitorName)
                )
            ) {
                eventsMap[eventId].couples.push([competitorName, partnerName]);
            }
        });
    });

    return eventsMap;
}

// --- 7. Format and Output Results ---
function formatAndOutputResults(eventsGrouped, filename = "events.txt") {
    let outputString = ""; // Accumulate output for file writing

    // Sort event IDs numerically if possible, otherwise alphabetically
    const sortedEventIds = Object.keys(eventsGrouped).sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
        }
        // Fallback to string comparison if IDs are not purely numeric
        return a.localeCompare(b);
    });

    sortedEventIds.forEach((eventId) => {
        const event = eventsGrouped[eventId];
        const { eventName, couples } = event;

        const eventIdDisplay = eventId.toString().startsWith("unknown_")
            ? "Unknown ID"
            : `Event ID: ${eventId}`;

        let section = "";
        section += `${chalk.bgBlue.white.bold(`\n${eventIdDisplay}`)}\n`;
        section += `${chalk.bold(chalk.green(`Event Name:`))} ${chalk.cyan(
            eventName
        )}\n`;
        section += `${chalk.bold("Couples:")}\n`;

        if (couples.length === 0) {
            section += `${chalk.yellow("  No couples registered.")}\n`;
        } else {
            // Sort couples alphabetically by the first partner's name
            couples.sort((a, b) => a[0].localeCompare(b[0]));
            couples.forEach((couple, index) => {
                section += `${chalk.magenta(
                    `  ${index + 1}. ${chalk.bold(couple[0])} & ${chalk.bold(couple[1])}`
                )}\n`;
            });
        }
        section += `${chalk.gray("-------------------------------\n")}`;
        outputString += section; // Add section to file output
        process.stdout.write(section); // Write section to console directly
    });

    // Remove chalk formatting for the file
    const plainTextOutput = outputString.replace(
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        ""
    );

    try {
        fs.writeFileSync(filename, plainTextOutput);
        console.log(`\n✅ Output has been saved to ${filename}`);
    } catch (error) {
        console.error(`\n❌ Failed to write output to ${filename}:`, error.message);
    }
}

// --- 8. Main Orchestration ---
async function runScraper() {
    try {
        const o2cmEvent = getEventIdFromUser();
        if (!o2cmEvent) {
            console.log("No event ID entered. Exiting.");
            return;
        }

        const competitorIds = await fetchCompetitorIds(o2cmEvent);
        let allEntries = [];

        // Sequentially process each competitor ID to avoid overwhelming the server
        for (const id of competitorIds) {
            const entries = await fetchCompetitorData(o2cmEvent, id);
            allEntries.push(...entries);
            // Optional small delay to be polite to the server
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const uniquePartnershipEntries = deduplicateEntries(allEntries);
        const groupedByEvent = groupResultsByEvent(uniquePartnershipEntries);
        formatAndOutputResults(groupedByEvent);
    } catch (error) {
        console.error(
            "\n❌ An error occurred during the scraping process:",
            error.message
        );
        // For more detailed debugging:
        // console.error(error.stack);
    }
}

// --- Start the process ---
runScraper();