import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const MODEL_TIMEOUT_MS = 300;
const TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function invalidInput() {
	return { statusCode: 400, body: { status: "invalid_input" } };
}

function manualReview() {
	return {
		statusCode: 200,
		body: { status: "manual_review", topic: null, draft: null },
	};
}

export async function triage(rawBody) {
	let payload;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return invalidInput();
	}

	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		return invalidInput();
	}

	const { text } = payload;
	if (typeof text !== "string" || text.length === 0) {
		return invalidInput();
	}

	const controller = new AbortController();
	let timer;
	const pending = classify(text, { signal: controller.signal });
	pending.catch(() => {});

	let raw;
	try {
		raw = await new Promise((resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("timeout"));
			}, MODEL_TIMEOUT_MS);
			pending.then(resolve, reject);
		});
	} catch {
		return manualReview();
	} finally {
		clearTimeout(timer);
	}

	return acceptModelResult(raw);
}

function acceptModelResult(raw) {
	if (typeof raw !== "string") return manualReview();

	let model;
	try {
		model = JSON.parse(raw);
	} catch {
		return manualReview();
	}

	if (model === null || typeof model !== "object" || Array.isArray(model)) {
		return manualReview();
	}

	const { topic, draft } = model;
	if (!TOPICS.has(topic) || typeof draft !== "string" || draft.trim() === "") {
		return manualReview();
	}

	return { statusCode: 200, body: { status: "ready", topic, draft } };
}

async function handleTriage(request, response) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const result = await triage(Buffer.concat(chunks).toString("utf8"));
	json(response, result.statusCode, result.body);
}

function handleRequest(request, response) {
	if (request.method === "GET" && request.url === "/") {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
		return;
	}
	if (request.method !== "POST" || request.url !== "/api/triage") {
		json(response, 404, { status: "not_found" });
		return;
	}
	handleTriage(request, response).catch(() => {
		if (!response.headersSent) json(response, 500, { status: "server_error" });
	});
}

export function startServer(port = Number(process.env.PORT || 3000)) {
	const server = createServer(handleRequest);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}

const invoked = process.argv[1];
const invokedUrl = invoked ? pathToFileURL(path.resolve(invoked)).href : "";
if (invokedUrl === import.meta.url) {
	startServer().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
