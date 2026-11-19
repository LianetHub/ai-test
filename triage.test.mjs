import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer } from "./server.mjs";

let server;
let base;

before(async () => {
	server = await startServer(0);
	base = `http://127.0.0.1:${server.address().port}`;
});

after(
	() =>
		new Promise((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		}),
);

async function post(body, { raw = false } = {}) {
	const response = await fetch(`${base}/api/triage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: raw ? body : JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() };
}

test("сбой модели переводит заявку на ручной разбор и не оставляет черновик", async () => {
	const markers = ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"];

	for (const marker of markers) {
		const started = Date.now();
		const result = await post({ text: `Нужна помощь по заказу ${marker}` });
		const elapsed = Date.now() - started;

		assert.equal(result.status, 200, marker);
		assert.deepEqual(
			result.body,
			{
				status: "manual_review",
				topic: null,
				draft: null,
			},
			marker,
		);
		assert.ok(elapsed < 1000, `${marker} занял ${elapsed} мс вместо лимита 300 мс`);
	}

	const recovered = await post({ text: "Где доставка моего заказа?" });
	assert.equal(recovered.status, 200);
	assert.equal(recovered.body.status, "ready");
	assert.equal(recovered.body.topic, "delivery");
	assert.equal(typeof recovered.body.draft, "string");
	assert.ok(recovered.body.draft.trim().length > 0);
});

test("пустой и некорректный ввод отклоняется", async () => {
	const cases = [
		{ body: { text: "" } },
		{ body: {} },
		{ body: { text: null } },
		{ body: { text: 42 } },
		{ body: [], raw: false },
		{ body: "{", raw: true },
		{ body: "", raw: true },
	];

	for (const item of cases) {
		const result = item.raw ? await post(item.body, { raw: true }) : await post(item.body);
		assert.equal(result.status, 400);
		assert.deepEqual(result.body, { status: "invalid_input" });
	}
});

test("корректный ответ модели возвращает тему и непустой черновик", async () => {
	const delivery = await post({ text: "Задерживается доставка" });
	assert.deepEqual(delivery.body, {
		status: "ready",
		topic: "delivery",
		draft: "Спасибо за обращение. Уточним детали заявки.",
	});

	const pricing = await post({ text: "Какая цена у тарифа?" });
	assert.equal(pricing.body.status, "ready");
	assert.equal(pricing.body.topic, "pricing");

	const other = await post({ text: "Хочу уточнить детали обращения" });
	assert.equal(other.body.status, "ready");
	assert.equal(other.body.topic, "other");
});
