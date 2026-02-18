/**
 * Storage Benchmark (100 queries) — comprehensive test of storage decisions across all node types.
 * Covers: plans, events, facts, instructions, opinions, corrections, mixed messages,
 *         and 45 cases that should NOT store (questions, small talk, hypotheticals, vague statements).
 *
 * Usage:
 *   bun test-storage-100.ts
 *   bun test-storage-100.ts --only S01,S05,S42
 *   bun test-storage-100.ts --only S56-S100        (range syntax)
 *   bun test-storage-100.ts --category plans        (run a category)
 */
import { classify } from "../src/memory/layer1";
import { agenticLoop } from "../src/memory/layer2";
import { getDb } from "../src/memory/db-core";
import { resetUsage, getUsage } from "../src/memory/usage-tracker";
import { scoreStorageResult, parseOnlyFlag } from "./bench-utils";
import Database from "bun:sqlite";

const DB_PATH = process.env.DB_PATH || `${process.env.HOME}/.octybot/test/memory.db`;
process.env.DB_PATH = DB_PATH;

// ── Query definitions ──────────────────────────────────────────────────

interface StorageQuery {
  id: string;
  prompt: string;
  should_store: boolean;
  expected_types?: string[];
  expected_keywords?: string[];
  description: string;
  category: string;
}

const ALL_QUERIES: StorageQuery[] = [

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD STORE — Plans (S01–S15)
  // ════════════════════════════════════════════════════════════════════

  { id: "S01", category: "plans",
    prompt: "Dave is going on holiday on the 3rd of March",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Dave", "holiday"],
    description: "Simple plan with specific date",
  },
  { id: "S02", category: "plans",
    prompt: "The Anderson delivery is due next Friday",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Anderson", "delivery"],
    description: "Plan with relative date — client deliverable",
  },
  { id: "S03", category: "plans",
    prompt: "Dave is going on holiday March 3rd, Peter will cover his Brightwell articles while he's away",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Dave", "Peter", "Brightwell"],
    description: "Plan with coverage change — multi-entity",
  },
  { id: "S04", category: "plans",
    prompt: "We're planning to onboard two new writers in April",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["writer"],
    description: "Intended plan — soft date, no firm commitment",
  },
  { id: "S05", category: "plans",
    prompt: "Meridian Health wants their Q2 content calendar delivered by March 15th",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Meridian", "March"],
    description: "Requested plan — client deadline",
  },
  { id: "S06", category: "plans",
    prompt: "The team strategy meeting is scheduled for next Wednesday at 2pm",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["strategy meeting", "Wednesday"],
    description: "Scheduled plan — team event",
  },
  { id: "S07", category: "plans",
    prompt: "Sarah needs to complete the Brightwell audit by end of this month",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Sarah", "Brightwell", "audit"],
    description: "Plan — deadline for specific person/client",
  },
  { id: "S08", category: "plans",
    prompt: "We're launching the new client portal on April 1st",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["client portal", "April"],
    description: "Plan — product launch date",
  },
  { id: "S09", category: "plans",
    prompt: "Peter has a dentist appointment on Thursday so he'll be out in the afternoon",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Peter", "Thursday"],
    description: "Plan — personal absence with date",
  },
  { id: "S10", category: "plans",
    prompt: "TechForge wants us to start their blog series on cybersecurity next month, 4 articles per week",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["TechForge", "cybersecurity"],
    description: "Plan — new client content schedule",
  },
  { id: "S11", category: "plans",
    prompt: "The quarterly review with all writers is on March 20th",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["quarterly review", "March"],
    description: "Plan — recurring team event with date",
  },
  { id: "S12", category: "plans",
    prompt: "Lisa is planning to migrate the Airtable workspace to a new structure in two weeks",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Lisa", "Airtable"],
    description: "Plan — intended tool migration",
  },
  { id: "S13", category: "plans",
    prompt: "Canopy Digital's website redesign goes live on May 5th, we need all content finalized by April 28th",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Canopy", "May"],
    description: "Plan — cascading deadlines",
  },
  { id: "S14", category: "plans",
    prompt: "Anderson has requested a meeting next Tuesday to discuss expanding their content package",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Anderson", "Tuesday", "meeting"],
    description: "Plan — requested meeting with client",
  },
  { id: "S15", category: "plans",
    prompt: "Jeff is attending a content marketing conference in Berlin from March 10-12",
    should_store: true,
    expected_types: ["plan"],
    expected_keywords: ["Jeff", "Berlin", "March"],
    description: "Plan — staff travel/absence",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD STORE — Events (S16–S25)
  // ════════════════════════════════════════════════════════════════════

  { id: "S16", category: "events",
    prompt: "Peter just finished 3 articles for Anderson ahead of schedule",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Peter", "Anderson", "3 articles"],
    description: "Concrete event — work completed early",
  },
  { id: "S17", category: "events",
    prompt: "We lost the Greenfield account yesterday — they're moving to an agency",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Greenfield"],
    description: "High-salience event — lost client",
  },
  { id: "S18", category: "events",
    prompt: "Sarah flagged two of Dave's articles on Monday for quality issues",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Sarah", "Dave"],
    description: "Event — quality incident",
  },
  { id: "S19", category: "events",
    prompt: "Dave missed the Brightwell deadline again this week",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Dave", "Brightwell", "deadline"],
    description: "Event — repeated missed deadline",
  },
  { id: "S20", category: "events",
    prompt: "Marcus signed a new client called NovaTech — they'll start with 5 articles per month",
    should_store: true,
    expected_types: ["event", "entity"],
    expected_keywords: ["NovaTech", "5 articles"],
    description: "Event + new entity — client signing",
  },
  { id: "S21", category: "events",
    prompt: "Lisa fixed the broken Airtable automation that was mislabeling article statuses",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Lisa", "Airtable"],
    description: "Event — technical fix",
  },
  { id: "S22", category: "events",
    prompt: "The team decided to switch from Slack to Microsoft Teams for internal comms",
    should_store: true,
    expected_types: ["event", "fact"],
    expected_keywords: ["Teams"],
    description: "Decision event with factual implication",
  },
  { id: "S23", category: "events",
    prompt: "Peter had a call with Anderson's marketing director today to discuss Q2 topics",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Peter", "Anderson"],
    description: "Event — client conversation",
  },
  { id: "S24", category: "events",
    prompt: "Jeff ran all 8 articles through Originality.ai yesterday and they all passed",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Jeff", "Originality"],
    description: "Event — routine check with outcome",
  },
  { id: "S25", category: "events",
    prompt: "Brightwell's CEO personally emailed to compliment the latest batch of articles",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Brightwell"],
    description: "Event — notable client feedback",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD STORE — Facts (S26–S35)
  // ════════════════════════════════════════════════════════════════════

  { id: "S26", category: "facts",
    prompt: "Peter now handles the Anderson account instead of Dave",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Peter", "Anderson"],
    description: "Fact — role/responsibility change",
  },
  { id: "S27", category: "facts",
    prompt: "The Anderson retainer is increasing to £5,000 starting next month",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Anderson", "5,000"],
    description: "Fact — price/rate change",
  },
  { id: "S28", category: "facts",
    prompt: "We're switching from WordPress to Webflow for Canopy Digital's site",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Webflow", "Canopy"],
    description: "Fact — platform change for client",
  },
  { id: "S29", category: "facts",
    prompt: "Brightwell wants to add video scripts to their content package",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Brightwell", "video"],
    description: "Fact — client want for new content type",
  },
  { id: "S30", category: "facts",
    prompt: "Our total monthly revenue is now £12,600 across all clients",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["12,600"],
    description: "Fact — financial figure",
  },
  { id: "S31", category: "facts",
    prompt: "Dave's average Surfer score has improved from 65 to 82 this quarter",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Dave", "82"],
    description: "Fact — metric improvement with numbers",
  },
  { id: "S32", category: "facts",
    prompt: "Sarah's email is sarah.thompson@wobs.co.uk and she prefers being contacted on Slack",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Sarah", "sarah.thompson"],
    description: "Fact — contact details + preference",
  },
  { id: "S33", category: "facts",
    prompt: "Peter negotiated a raise to £250 per article, effective immediately",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Peter", "250"],
    description: "Fact — individual rate change",
  },
  { id: "S34", category: "facts",
    prompt: "Lisa handles all the Airtable administration and Jeff handles the CMS uploads",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Lisa", "Airtable", "Jeff"],
    description: "Fact — multi-entity responsibility assignment",
  },
  { id: "S35", category: "facts",
    prompt: "Meridian Health has a strict 48-hour turnaround requirement for all content revisions",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Meridian", "48"],
    description: "Fact — client SLA requirement",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD STORE — Instructions (S36–S45)
  // ════════════════════════════════════════════════════════════════════

  { id: "S36", category: "instructions",
    prompt: "From now on, all articles need to be at least 1500 words minimum",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["1500"],
    description: "Instruction — universal rule (scope ~1.0)",
  },
  { id: "S37", category: "instructions",
    prompt: "When using Surfer SEO, always target a score of at least 75 before submitting",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["Surfer", "75"],
    description: "Instruction — tool-specific rule",
  },
  { id: "S38", category: "instructions",
    prompt: "Remember, never use stock photos in Meridian Health articles — they require original imagery only",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["Meridian", "stock photo"],
    description: "Instruction — entity-specific rule (scope ~0.2)",
  },
  { id: "S39", category: "instructions",
    prompt: "The content QA process is: first run through Surfer, then Grammarly, then Originality.ai, then send to Sarah for final review",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["Surfer", "Grammarly", "Originality"],
    description: "Instruction — multi-step process",
  },
  { id: "S40", category: "instructions",
    prompt: "Canopy Digital is the exception to the 1500 word rule — their articles should be 800-1000 words",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["Canopy", "800"],
    description: "Instruction — exception to a rule",
  },
  { id: "S41", category: "instructions",
    prompt: "All writers must now submit a brief outline to Sarah before starting any article",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["outline", "Sarah"],
    description: "Instruction — new workflow step",
  },
  { id: "S42", category: "instructions",
    prompt: "Always check Originality.ai scores before submitting to any client — if it's below 95% original, rewrite the flagged sections",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["Originality", "95"],
    description: "Instruction — universal quality check (scope ~1.0)",
  },
  { id: "S43", category: "instructions",
    prompt: "GSC reports should be pulled on the 1st of every month using the Google Search Console performance tab",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["GSC", "1st"],
    description: "Instruction — scheduled tool procedure",
  },
  { id: "S44", category: "instructions",
    prompt: "When a writer misses a deadline, notify Sarah immediately and note it in the Airtable tracker",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["deadline", "Sarah", "Airtable"],
    description: "Instruction — escalation procedure",
  },
  { id: "S45", category: "instructions",
    prompt: "Never commit code directly to main — always use a feature branch and get at least one review",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["main", "feature branch"],
    description: "Instruction — dev workflow rule",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD STORE — Opinions (S46–S50)
  // ════════════════════════════════════════════════════════════════════

  { id: "S46", category: "opinions",
    prompt: "I think Sarah is doing an amazing job managing quality control this quarter",
    should_store: true,
    expected_types: ["opinion"],
    expected_keywords: ["Sarah"],
    description: "Opinion — positive performance assessment",
  },
  { id: "S47", category: "opinions",
    prompt: "Honestly, Grammarly isn't catching enough issues — I think we should evaluate ProWritingAid instead",
    should_store: true,
    expected_types: ["opinion"],
    expected_keywords: ["Grammarly"],
    description: "Opinion — tool dissatisfaction",
  },
  { id: "S48", category: "opinions",
    prompt: "I feel like we're taking on too many clients for our current team size",
    should_store: true,
    expected_types: ["opinion"],
    expected_keywords: ["too many clients"],
    description: "Opinion — capacity concern",
  },
  { id: "S49", category: "opinions",
    prompt: "Dave's writing has really improved this quarter compared to last",
    should_store: true,
    expected_types: ["opinion"],
    expected_keywords: ["Dave"],
    description: "Opinion — writer improvement assessment",
  },
  { id: "S50", category: "opinions",
    prompt: "I'm not happy with how long Brightwell takes to approve content — they're the slowest client by far",
    should_store: true,
    expected_types: ["opinion"],
    expected_keywords: ["Brightwell", "slow"],
    description: "Opinion — client process frustration",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD STORE — Mixed / Edge Cases (S51–S55)
  // ════════════════════════════════════════════════════════════════════

  { id: "S51", category: "mixed",
    prompt: "Peter finished the Anderson draft today and the final version is due next Wednesday",
    should_store: true,
    expected_types: ["event", "plan"],
    expected_keywords: ["Peter", "Anderson", "Wednesday"],
    description: "Mixed — past event + upcoming plan in same message",
  },
  { id: "S52", category: "mixed",
    prompt: "Lisa created a new Airtable view called 'Overdue' to track late assignments — I think it's going to be really useful",
    should_store: true,
    expected_types: ["fact", "opinion"],
    expected_keywords: ["Lisa", "Airtable", "Overdue"],
    description: "Mixed — fact + opinion",
  },
  { id: "S53", category: "mixed",
    prompt: "Actually, Lisa handles the Airtable now, not Jeff — Jeff moved to CMS management last month",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Lisa", "Jeff"],
    description: "Correction — responsibility reassignment",
  },
  { id: "S54", category: "mixed",
    prompt: "Marcus just signed a new client called TechForge — they want 10 articles per month on cybersecurity at £200 per article",
    should_store: true,
    expected_types: ["entity", "fact"],
    expected_keywords: ["TechForge", "10 articles", "cybersecurity"],
    description: "Mixed — new entity + facts",
  },
  { id: "S55", category: "mixed",
    prompt: "We've decided to use Grammarly as an additional editing tool for all writers — make sure everyone runs it before submitting",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["Grammarly"],
    description: "Mixed — decision event + instruction",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD NOT STORE — Questions (S56–S70)
  // ════════════════════════════════════════════════════════════════════

  { id: "S56", category: "questions",
    prompt: "Who writes for Anderson?",
    should_store: false,
    description: "Question — simple entity lookup",
  },
  { id: "S57", category: "questions",
    prompt: "What's Dave's average Surfer score?",
    should_store: false,
    description: "Question — asking about existing metric",
  },
  { id: "S58", category: "questions",
    prompt: "How do I publish an article to a client site?",
    should_store: false,
    description: "Question — process inquiry",
  },
  { id: "S59", category: "questions",
    prompt: "Is Peter faster than Dave at writing articles?",
    should_store: false,
    description: "Question — comparative",
  },
  { id: "S60", category: "questions",
    prompt: "When is the next GSC report due?",
    should_store: false,
    description: "Question — schedule query",
  },
  { id: "S61", category: "questions",
    prompt: "How do I run a Surfer SEO check?",
    should_store: false,
    description: "Question — tool process inquiry",
  },
  { id: "S62", category: "questions",
    prompt: "What tools do we use for content checking?",
    should_store: false,
    description: "Question — entity/tool lookup",
  },
  { id: "S63", category: "questions",
    prompt: "Does Sarah review all articles before they go to clients?",
    should_store: false,
    description: "Question — verification/yes-no",
  },
  { id: "S64", category: "questions",
    prompt: "Can you remind me of Sarah's role?",
    should_store: false,
    description: "Question — entity info request",
  },
  { id: "S65", category: "questions",
    prompt: "Tell me about Meridian Health",
    should_store: false,
    description: "Question — entity lookup",
  },
  { id: "S66", category: "questions",
    prompt: "What are Dave's upcoming deadlines?",
    should_store: false,
    description: "Question — asking about existing plans",
  },
  { id: "S67", category: "questions",
    prompt: "What happened with the Brightwell delivery last week?",
    should_store: false,
    description: "Question — asking about past event",
  },
  { id: "S68", category: "questions",
    prompt: "How many articles does Brightwell get per month?",
    should_store: false,
    description: "Question — factual query",
  },
  { id: "S69", category: "questions",
    prompt: "What clients do we have?",
    should_store: false,
    description: "Question — entity list request",
  },
  { id: "S70", category: "questions",
    prompt: "Who is responsible for AI detection checks?",
    should_store: false,
    description: "Question — role inquiry",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD NOT STORE — Greetings & Small Talk (S71–S77)
  // ════════════════════════════════════════════════════════════════════

  { id: "S71", category: "smalltalk",
    prompt: "Hey, good morning!",
    should_store: false,
    description: "Greeting — no information",
  },
  { id: "S72", category: "smalltalk",
    prompt: "Thanks for the help, that's all for now!",
    should_store: false,
    description: "Small talk — sign-off",
  },
  { id: "S73", category: "smalltalk",
    prompt: "OK got it, thanks",
    should_store: false,
    description: "Small talk — acknowledgment",
  },
  { id: "S74", category: "smalltalk",
    prompt: "Sounds good, let's move on",
    should_store: false,
    description: "Small talk — agreement",
  },
  { id: "S75", category: "smalltalk",
    prompt: "Hi there, hope you're having a great day",
    should_store: false,
    description: "Greeting — pleasantry",
  },
  { id: "S76", category: "smalltalk",
    prompt: "Sure, that makes sense",
    should_store: false,
    description: "Small talk — confirmation",
  },
  { id: "S77", category: "smalltalk",
    prompt: "Right, I see what you mean",
    should_store: false,
    description: "Small talk — understanding acknowledgment",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD NOT STORE — Hypotheticals (S78–S84)
  // ════════════════════════════════════════════════════════════════════

  { id: "S78", category: "hypotheticals",
    prompt: "If we hired another writer, who would they report to?",
    should_store: false,
    description: "Hypothetical — speculative staffing question",
  },
  { id: "S79", category: "hypotheticals",
    prompt: "What would happen if Dave missed another deadline?",
    should_store: false,
    description: "Hypothetical — consequence speculation",
  },
  { id: "S80", category: "hypotheticals",
    prompt: "Would it make sense to offer Brightwell a discount if they increased volume?",
    should_store: false,
    description: "Hypothetical — pricing scenario",
  },
  { id: "S81", category: "hypotheticals",
    prompt: "What if we moved all clients to a single CMS platform?",
    should_store: false,
    description: "Hypothetical — technology scenario",
  },
  { id: "S82", category: "hypotheticals",
    prompt: "If Peter left, could Dave handle the Anderson workload?",
    should_store: false,
    description: "Hypothetical — capacity speculation",
  },
  { id: "S83", category: "hypotheticals",
    prompt: "I wonder if we should consider adding social media management to our services",
    should_store: false,
    description: "Hypothetical — musing about expansion",
  },
  { id: "S84", category: "hypotheticals",
    prompt: "When Peter finishes the current batch, should we assign him to Meridian too?",
    should_store: false,
    description: "Hypothetical — conditional question about future assignment",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD NOT STORE — Vague / Common Sense / Tautologies (S85–S91)
  // ════════════════════════════════════════════════════════════════════

  { id: "S85", category: "vague",
    prompt: "Articles need to be well-written and engaging for the reader",
    should_store: false,
    description: "Vague — generic quality truism",
  },
  { id: "S86", category: "vague",
    prompt: "Writers write articles and editors edit them",
    should_store: false,
    description: "Vague — tautology about roles",
  },
  { id: "S87", category: "vague",
    prompt: "Good content is important for client retention",
    should_store: false,
    description: "Vague — common sense business statement",
  },
  { id: "S88", category: "vague",
    prompt: "We should try to do better next quarter",
    should_store: false,
    description: "Vague — generic aspiration with no specifics",
  },
  { id: "S89", category: "vague",
    prompt: "SEO is really important for content marketing",
    should_store: false,
    description: "Vague — industry common knowledge",
  },
  { id: "S90", category: "vague",
    prompt: "Deadlines are important and we should meet them",
    should_store: false,
    description: "Vague — self-evident statement",
  },
  { id: "S91", category: "vague",
    prompt: "Peter finishes articles",
    should_store: false,
    description: "Vague — that's just his job, no new info",
  },

  // ════════════════════════════════════════════════════════════════════
  //  SHOULD NOT STORE — Delegation / Status / Meta (S92–S100)
  // ════════════════════════════════════════════════════════════════════

  { id: "S92", category: "meta",
    prompt: "Give me a summary of everything you know about our team",
    should_store: false,
    description: "Meta — summary request, no new info",
  },
  { id: "S93", category: "meta",
    prompt: "How many memories do you have stored?",
    should_store: false,
    description: "Meta — system question about memory",
  },
  { id: "S94", category: "meta",
    prompt: "Can you compare Peter and Dave's productivity?",
    should_store: false,
    description: "Question — comparison/analysis request",
  },
  { id: "S95", category: "meta",
    prompt: "Show me all the rules we have about content quality",
    should_store: false,
    description: "Question — instruction retrieval request",
  },
  { id: "S96", category: "meta",
    prompt: "What do you think we should prioritize this week?",
    should_store: false,
    description: "Meta — asking for recommendation",
  },
  { id: "S97", category: "meta",
    prompt: "Walk me through the steps for onboarding a new client",
    should_store: false,
    description: "Question — process walkthrough request",
  },
  { id: "S98", category: "meta",
    prompt: "Check if Peter is assigned to any articles right now",
    should_store: false,
    description: "Delegation — status check, no new info",
  },
  { id: "S99", category: "meta",
    prompt: "Wait, what did I tell you about the Anderson account earlier?",
    should_store: false,
    description: "Meta — asking about previous context",
  },
  { id: "S100", category: "meta",
    prompt: "Never mind, forget what I just said about that",
    should_store: false,
    description: "Meta — retraction with nothing specific to store",
  },
];

// ── Scoring ──────────────────────────────────────────────────────────

interface QueryResult {
  id: string;
  prompt: string;
  category: string;
  should_store: boolean;
  did_store: boolean;
  stored_nodes: { type: string; subtype: string; content: string; scope?: number; salience?: number; valid_from?: string }[];
  expected_types?: string[];
  expected_keywords?: string[];
  type_hits: string[];
  type_misses: string[];
  keyword_hits: string[];
  keyword_misses: string[];
  pass: boolean;
  failure_reason?: string;
  nodes_before: number;
  nodes_after: number;
  timing: any;
}


// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const onlyIds = parseOnlyFlag(process.argv);

  // Parse --category flag
  const catArg = process.argv.find(a => a.startsWith("--category"))?.split("=")[1]
    ?? (process.argv.indexOf("--category") >= 0 ? process.argv[process.argv.indexOf("--category") + 1] : null);

  let queries: StorageQuery[];
  if (onlyIds) {
    queries = ALL_QUERIES.filter(q => onlyIds!.has(q.id));
  } else if (catArg) {
    queries = ALL_QUERIES.filter(q => q.category === catArg);
  } else {
    queries = ALL_QUERIES;
  }

  if (queries.length === 0) {
    const categories = [...new Set(ALL_QUERIES.map(q => q.category))];
    console.error(`No queries matched. Available categories: ${categories.join(", ")}`);
    console.error(`Query IDs: S01–S${String(ALL_QUERIES.length).padStart(2, "0")}`);
    process.exit(1);
  }

  const BATCH_SIZE = 25;
  const FREEZE_NAME = "storage-test-1";

  console.log(`Storage Benchmark (100) — running ${queries.length} queries`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Freeze: ${FREEZE_NAME} (restored before each store query)\n`);

  const results: QueryResult[] = [];
  let totalPass = 0;
  let totalFail = 0;

  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    const batchLabel = `[${i + 1}–${Math.min(i + BATCH_SIZE, queries.length)}/${queries.length}]`;
    console.log(`${batchLabel}`);

    const batchResults = await Promise.all(batch.map(async (q) => {
      // Restore DB to clean state before each query
      const snapshotPath = `${process.env.HOME}/.octybot/test/snapshots/small-baseline/${FREEZE_NAME}.db`;
      const restoreDb = new Database(snapshotPath, { readonly: true });
      const activeDb = new Database(DB_PATH);
      activeDb.exec("DELETE FROM nodes");
      activeDb.exec("DELETE FROM edges");
      activeDb.exec("DELETE FROM embeddings");

      const nodes = restoreDb.query("SELECT * FROM nodes").all() as any[];
      const edges = restoreDb.query("SELECT * FROM edges").all() as any[];
      const embeddings = restoreDb.query("SELECT * FROM embeddings").all() as any[];

      if (nodes.length > 0) {
        const cols = Object.keys(nodes[0]);
        const placeholders = cols.map(() => "?").join(",");
        const insertNode = activeDb.prepare(`INSERT OR REPLACE INTO nodes (${cols.join(",")}) VALUES (${placeholders})`);
        for (const n of nodes) insertNode.run(...cols.map(c => n[c]));
      }
      if (edges.length > 0) {
        const cols = Object.keys(edges[0]);
        const placeholders = cols.map(() => "?").join(",");
        const insertEdge = activeDb.prepare(`INSERT OR REPLACE INTO edges (${cols.join(",")}) VALUES (${placeholders})`);
        for (const e of edges) insertEdge.run(...cols.map(c => e[c]));
      }
      if (embeddings.length > 0) {
        const cols = Object.keys(embeddings[0]);
        const placeholders = cols.map(() => "?").join(",");
        const insertEmb = activeDb.prepare(`INSERT OR REPLACE INTO embeddings (${cols.join(",")}) VALUES (${placeholders})`);
        for (const e of embeddings) insertEmb.run(...cols.map(c => e[c]));
      }

      const nodesBefore = (activeDb.query("SELECT COUNT(*) as c FROM nodes").get() as any).c;
      restoreDb.close();
      activeDb.close();

      // Run pipeline
      const l1c = await classify(q.prompt);
      const l1 = l1c.result;
      const result = await agenticLoop(getDb(), q.prompt, l1);

      // Collect stored nodes from tool calls
      const stored_nodes: QueryResult["stored_nodes"] = [];
      for (const turn of result.turns) {
        if ((turn as any)._pipeline === "store" && turn.tool_call.name === "store_memory") {
          const args = typeof turn.tool_call.arguments === "string"
            ? JSON.parse(turn.tool_call.arguments)
            : turn.tool_call.arguments;
          stored_nodes.push({
            type: args.type,
            subtype: args.subtype || "",
            content: args.content,
            scope: args.scope,
            salience: args.salience,
            valid_from: args.valid_from,
          });
        }
      }

      const did_store = stored_nodes.length > 0;
      const nodesAfterDb = new Database(DB_PATH, { readonly: true });
      const nodesAfter = (nodesAfterDb.query("SELECT COUNT(*) as c FROM nodes").get() as any).c;
      nodesAfterDb.close();

      const score = scoreStorageResult(q, did_store, stored_nodes);

      return {
        id: q.id,
        prompt: q.prompt,
        category: q.category,
        should_store: q.should_store,
        did_store,
        stored_nodes,
        expected_types: q.expected_types,
        expected_keywords: q.expected_keywords,
        ...score,
        nodes_before: nodesBefore,
        nodes_after: nodesAfter,
        timing: result.timing,
      } as QueryResult;
    }));

    for (const r of batchResults) {
      results.push(r);
      if (r.pass) totalPass++;
      else totalFail++;

      const icon = r.pass ? "\u2713" : "\u2717";
      const storeLabel = r.should_store
        ? (r.did_store ? `stored ${r.stored_nodes.length} nodes` : "MISSED (nothing stored)")
        : (r.did_store ? `LEAKED ${r.stored_nodes.length} nodes` : "correctly skipped");

      const kwInfo = r.keyword_misses.length > 0 ? ` | MISS: ${r.keyword_misses.join(", ")}` : "";
      const typeInfo = r.type_misses.length > 0 ? ` | missing types: ${r.type_misses.join(", ")}` : "";
      const planInfo = r.stored_nodes.some(n => n.type === "plan")
        ? ` [plan${r.stored_nodes.find(n => n.type === "plan")?.valid_from ? ": " + r.stored_nodes.find(n => n.type === "plan")?.valid_from : ""}]`
        : "";

      console.log(`  ${r.id}: ${icon} ${storeLabel}${planInfo} — "${r.prompt.slice(0, 55)}"${kwInfo}${typeInfo}`);
      if (r.failure_reason && !r.pass) {
        console.log(`       FAIL: ${r.failure_reason}`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const storeQueries = results.filter(r => r.should_store);
  const noStoreQueries = results.filter(r => !r.should_store);
  const storeCorrect = storeQueries.filter(r => r.did_store).length;
  const noStoreCorrect = noStoreQueries.filter(r => !r.did_store).length;
  const typeHitTotal = results.reduce((s, r) => s + r.type_hits.length, 0);
  const typeTotalExpected = results.reduce((s, r) => s + (r.expected_types?.length || 0), 0);
  const kwHitTotal = results.reduce((s, r) => s + r.keyword_hits.length, 0);
  const kwTotalExpected = results.reduce((s, r) => s + (r.expected_keywords?.length || 0), 0);

  // Category breakdown
  const categories = [...new Set(ALL_QUERIES.map(q => q.category))];
  const catStats: Record<string, { total: number; pass: number }> = {};
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    catStats[cat] = {
      total: catResults.length,
      pass: catResults.filter(r => r.pass).length,
    };
  }

  // Plan-specific stats
  const planQueries = results.filter(r => r.category === "plans");
  const plansWithValidFrom = planQueries.filter(r =>
    r.stored_nodes.some(n => n.type === "plan" && n.valid_from)
  ).length;
  const plansTypedCorrectly = planQueries.filter(r =>
    r.stored_nodes.some(n => n.type === "plan")
  ).length;

  // Instruction salience check — verify no instructions got salience > 1.0
  const instrQueries = results.filter(r => r.category === "instructions");
  const instrWithHighSalience = instrQueries.filter(r =>
    r.stored_nodes.some(n => n.type === "instruction" && (n.salience ?? 1.0) > 1.1)
  );

  console.log(`\n${"=".repeat(80)}`);
  console.log(`  STORAGE BENCHMARK SUMMARY (${queries.length} queries)`);
  console.log(`${"=".repeat(80)}`);
  console.log(`  Overall:         ${totalPass}/${queries.length} pass (${Math.round(totalPass / queries.length * 100)}%)`);
  console.log(`  Store decisions:  ${storeCorrect}/${storeQueries.length} correctly stored`);
  console.log(`  Skip decisions:   ${noStoreCorrect}/${noStoreQueries.length} correctly skipped`);
  console.log(`  Type accuracy:    ${typeHitTotal}/${typeTotalExpected} expected types found`);
  console.log(`  Keyword accuracy: ${kwHitTotal}/${kwTotalExpected} expected keywords found`);
  console.log();
  console.log(`  Category breakdown:`);
  for (const cat of categories) {
    const s = catStats[cat];
    const pct = Math.round(s.pass / s.total * 100);
    const icon = pct === 100 ? "\u2713" : "\u2717";
    console.log(`    ${icon} ${cat.padEnd(15)} ${s.pass}/${s.total} (${pct}%)`);
  }
  console.log();
  console.log(`  Plan-specific:`);
  console.log(`    Plans typed correctly:  ${plansTypedCorrectly}/${planQueries.length}`);
  console.log(`    Plans with valid_from:  ${plansWithValidFrom}/${planQueries.length}`);
  if (instrWithHighSalience.length > 0) {
    console.log(`\n  WARNING: ${instrWithHighSalience.length} instructions got salience > 1.0 (should be 1.0):`);
    for (const r of instrWithHighSalience) {
      const badNodes = r.stored_nodes.filter(n => n.type === "instruction" && (n.salience ?? 1.0) > 1.1);
      for (const n of badNodes) {
        console.log(`    ${r.id}: salience=${n.salience} — "${n.content.slice(0, 60)}"`);
      }
    }
  } else {
    console.log(`    Instruction salience:   all <= 1.0 (correct — no artificial boost)`);
  }
  console.log(`${"=".repeat(80)}\n`);

  // Show failures
  const failures = results.filter(r => !r.pass);
  if (failures.length > 0) {
    console.log("  FAILURES:");
    for (const f of failures) {
      console.log(`    ${f.id} [${f.category}]: ${f.failure_reason}`);
      if (f.stored_nodes.length > 0) {
        for (const n of f.stored_nodes) {
          const extras = [
            n.scope != null ? `scope=${n.scope}` : "",
            n.salience != null ? `sal=${n.salience}` : "",
            n.valid_from ? `from=${n.valid_from}` : "",
          ].filter(Boolean).join(", ");
          console.log(`      -> [${n.type}/${n.subtype}${extras ? " " + extras : ""}] "${n.content.slice(0, 80)}"`);
        }
      }
    }
    console.log();
  }

  // Show store details for store queries
  console.log("  STORE DETAILS:");
  for (const r of storeQueries) {
    const icon = r.pass ? "\u2713" : "\u2717";
    console.log(`    ${icon} ${r.id} [${r.category}]: "${r.prompt.slice(0, 65)}"`);
    for (const n of r.stored_nodes) {
      const extras = [
        n.scope != null ? `scope=${n.scope}` : "",
        n.salience != null ? `sal=${n.salience}` : "",
        n.valid_from ? `from=${n.valid_from}` : "",
      ].filter(Boolean).join(", ");
      console.log(`        [${n.type}/${n.subtype}${extras ? " " + extras : ""}] "${n.content.slice(0, 90)}"`);
    }
    if (r.stored_nodes.length === 0) console.log(`        (nothing stored)`);
  }

  // Save results
  const usage = getUsage();
  const outDir = `${process.env.HOME}/.octybot/test/storage-benchmarks`;
  const fs = await import("fs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/${new Date().toISOString().replace(/[:.]/g, "-")}_storage-100.json`;
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    db: DB_PATH,
    total_queries: queries.length,
    pass: totalPass,
    fail: totalFail,
    store_correct: storeCorrect,
    skip_correct: noStoreCorrect,
    type_accuracy: `${typeHitTotal}/${typeTotalExpected}`,
    keyword_accuracy: `${kwHitTotal}/${kwTotalExpected}`,
    category_stats: catStats,
    plan_stats: {
      typed_correctly: plansTypedCorrectly,
      with_valid_from: plansWithValidFrom,
      total: planQueries.length,
    },
    instruction_salience_violations: instrWithHighSalience.map(r => r.id),
    queries: results.map(r => ({
      id: r.id, prompt: r.prompt, category: r.category,
      should_store: r.should_store, did_store: r.did_store,
      pass: r.pass, failure_reason: r.failure_reason,
      stored_nodes: r.stored_nodes, timing: r.timing,
    })),
    usage,
  }, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
