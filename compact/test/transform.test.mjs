// Fixtures are real RT 5.0.11 responses to mcp-server-rt's read tools, from a test RT holding made-up
// tickets, with base64 content shortened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TRANSFORMS, MAX_TEXT, applyArgumentDefaults, htmlToMarkdown, transformResult, transformToolList,
} from "../transform.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));
const size = (v) => JSON.stringify(v).length;
const noRestUrls = (v) => assert.ok(!JSON.stringify(v).includes("/REST/2.0/"), "REST URLs remain");

test("get_transaction: Outlook-style email keeps the text and drops the rest", () => {
  const raw = fixture("get_transaction-email");
  const t = TRANSFORMS.get_transaction(raw);
  assert.equal(t.Ticket, "1");
  assert.equal(t.Creator, "root");
  assert.match(t.Headers, /^From: Alice Example <alice@customer\.example>$/m);
  assert.doesNotMatch(t.Headers, /Message-ID|X-MS|Content-Type/);
  assert.deepEqual(t.Attachments.map((a) => a.ContentType), ["text/plain", "image/png", "application/pdf"]);
  const [text, logo, pdf] = t.Attachments;
  assert.match(text.Content, /purchase order for the replacement switches/);
  assert.equal(logo.Filename, "image001.png");
  assert.equal(pdf.Content, "[application/pdf content not shown, 1000 bytes]");
  noRestUrls(t);
  assert.ok(size(t) < size(raw) / 10, `${size(t)} vs ${size(raw)}`);
});

test("get_transaction: plain reply and status change", () => {
  const reply = TRANSFORMS.get_transaction(fixture("get_transaction-reply"));
  assert.deepEqual(reply.Attachments.map((a) => a.ContentType), ["text/plain"]);
  assert.match(reply.Attachments[0].Content, /booked for Tuesday/);
  const status = TRANSFORMS.get_transaction(fixture("get_transaction-status"));
  assert.equal(status.Type, "Status");
  assert.equal(status.NewValue, "open");
  assert.equal(status.Attachments, undefined);
});

test("get_transaction: HTML-only message is converted to markdown", () => {
  const raw = fixture("get_transaction-html-reply");
  // Remove the plain-text alternative so only HTML remains.
  raw.Attachments = raw.Attachments.filter((a) => a.ContentType !== "text/plain");
  const t = TRANSFORMS.get_transaction(raw);
  const [html] = t.Attachments;
  assert.equal(html.ContentType, "text/html, converted to markdown");
  assert.equal(html.Content, "Great, thanks!\n\nAlice");
});

test("get_transaction: long text is cut short", () => {
  const t = TRANSFORMS.get_transaction({
    id: 1, Type: "Correspond",
    Attachments: [{ id: 9, Parent: "0", ContentType: "text/plain", Content: "x".repeat(MAX_TEXT + 500) }],
  });
  assert.ok(t.Attachments[0].Content.length < MAX_TEXT + 200);
  assert.match(t.Attachments[0].Content, /truncated: 20500 characters in all; get_attachment with id 9/);
});

test("get_ticket: keeps links, lifecycle and set custom fields", () => {
  const raw = fixture("get_ticket");
  const t = TRANSFORMS.get_ticket(raw);
  assert.equal(t._url, "http://localhost/Ticket/Display.html?id=1");
  assert.equal(t.Owner, "staff1");
  assert.deepEqual(t.Requestor, ["alice@customer.example"]);
  assert.deepEqual(t.CustomFields, { Site: "Leeds DC", Customer: "Customer 042 Ltd" });
  assert.deepEqual(t._hyperlinks.map((l) => l.to).sort(), ["rejected", "resolved", "stalled"]);
  assert.ok(t._hyperlinks.every((l) => l.ref === "lifecycle" && l.update && l.from === "open"));
  for (const k of ["Resolved", "Starts", "AdminCc", "EffectiveId", "TimeWorked"]) assert.ok(!(k in t), k);
  noRestUrls(t);
});

test("get_ticket: ticket links survive", () => {
  const t = TRANSFORMS.get_ticket({
    id: 5,
    _hyperlinks: [
      { ref: "self", type: "ticket", id: 5, _url: "https://rt.example/Ticket/Display.html?id=5" },
      { ref: "refers-to", type: "ticket", id: "7", _url: "https://rt.example/Ticket/Display.html?id=7" },
      { ref: "parent", type: "ticket", id: "3", _url: "https://rt.example/Ticket/Display.html?id=3" },
    ],
  });
  assert.deepEqual(t._hyperlinks, [
    { ref: "refers-to", id: "7", _url: "https://rt.example/Ticket/Display.html?id=7" },
    { ref: "parent", id: "3", _url: "https://rt.example/Ticket/Display.html?id=3" },
  ]);
});

test("get_ticket_history: hides RT's notification email records", () => {
  const raw = fixture("get_ticket_history");
  const h = TRANSFORMS.get_ticket_history(raw);
  assert.equal(h.items.length, 11);
  assert.equal(h.HiddenEmailRecords, 9);
  assert.equal(h.total, 20);
  assert.ok(h.items.every((i) => !/EmailRecord/.test(i.Type)));
  assert.deepEqual(h.items[0], { Created: "2026-11-26T19:12:44Z", Creator: "root", Type: "Create", id: "46" });
  noRestUrls(h);
});

test("get_ticket_attachments: lists only files", () => {
  const a = TRANSFORMS.get_ticket_attachments(fixture("get_ticket_attachments"));
  assert.deepEqual(a.items.map((i) => i.Filename), ["image001.png", "PO-48213.pdf"]);
  assert.equal(a.OmittedMessageParts, 18);
  noRestUrls(a);
});

test("get_ticket_attachments: keeps everything when Filename was not asked for", () => {
  const a = TRANSFORMS.get_ticket_attachments({ items: [{ id: "1", ContentType: "text/plain" }, { id: "2", ContentType: "multipart/mixed" }] });
  assert.equal(a.items.length, 2);
});

test("get_attachment: binary content is not returned, HTML is converted", () => {
  const pdf = TRANSFORMS.get_attachment({
    id: 7, ContentType: "application/pdf", Filename: "po.pdf", Content: Buffer.alloc(300).toString("base64"),
    Headers: "Content-Type: application/pdf\nContent-Disposition: attachment", MessageId: "x",
    TransactionId: { type: "transaction", id: "46", _url: "http://localhost/REST/2.0/transaction/46" },
  });
  assert.deepEqual(pdf, { id: 7, ContentType: "application/pdf", Filename: "po.pdf", Content: "[application/pdf content not shown, 300 bytes]", TransactionId: "46" });
  const html = TRANSFORMS.get_attachment({ id: 5, ContentType: "text/html", Content: "<p>Hello&nbsp;<b>there</b></p>" });
  assert.equal(html.Content, "Hello **there**");
  assert.equal(html.ContentType, "text/html, converted to markdown");
});

test("search_tickets: references collapsed, ticket links kept", () => {
  const raw = fixture("search_tickets");
  const s = TRANSFORMS.search_tickets(raw);
  assert.deepEqual(s.items[0], {
    Subject: "Ticket 1: printer on floor 1 not working", _url: "http://localhost/Ticket/Display.html?id=2", id: "2",
    Status: "new", Queue: "General", LastUpdated: "2026-11-26T19:12:45Z", Requestor: ["bob@customer.example"],
    Owner: "Nobody", Priority: "0",
  });
  assert.deepEqual({ ...s, items: undefined }, { pages: 1, page: 1, total: 16, items: undefined });
  assert.ok(size(s) < size(raw) * 0.6);
});

test("get_queue and get_queue_fields", () => {
  const q = TRANSFORMS.get_queue(fixture("get_queue"));
  assert.deepEqual(q.TicketCustomFields, ["Customer", "Site", "Contract ref", "Category", "Notes"]);
  assert.deepEqual(q.AdminCc, ["staff1"]);
  noRestUrls(q);
  const f = TRANSFORMS.get_queue_fields(fixture("get_queue_fields"));
  const customer = f.CustomFields.find((c) => c.Name === "Customer");
  assert.deepEqual(customer, {
    id: 2, Values: ["Customer 001 Ltd", "Customer 002 Ltd", "Customer 003 Ltd", "Customer 004 Ltd", "Customer 005 Ltd"],
    Type: "Select", MaxValues: "1", Name: "Customer", EntryHint: "Select one value", ContentFormat: "plain-text",
  });
  noRestUrls(f);
});

test("htmlToMarkdown: staff reply from RT's web editor", () => {
  const md = htmlToMarkdown(readFileSync(new URL("fixtures/staff-reply.html", import.meta.url), "utf8"));
  assert.match(md, /^We’ve booked the switches for Tuesday – the quote is below \(£1,240 \+ VAT\)\.$/m);
  assert.match(md, /^\| 48-port switch \| 4 +\| £280 +\|$/m);
  assert.match(md, /\[our wiki\]\(https:\/\/wiki\.example\/switch-install\)/);
  assert.match(md, /^\* Delivery 9am…$/m);
  assert.match(md, /^> Could you confirm delivery for next Tuesday\?$/m);
  assert.doesNotMatch(md, /cid:|Logo|&[a-z]+;/);
});

test("htmlToMarkdown: Outlook markup and styles are dropped", () => {
  const email = fixture("get_transaction-email");
  const html = email.Attachments.find((a) => a.ContentType === "text/html").Content;
  const md = htmlToMarkdown(html);
  assert.match(md, /^Please find attached the purchase order/m);
  assert.doesNotMatch(md, /MsoNormal|mso-|<|cid:/);
  assert.ok(md.length < html.length / 10);
});

test("transformResult leaves errors, non-JSON and other tools alone", () => {
  const err = { isError: true, content: [{ type: "text", text: '{"a":1}' }] };
  assert.equal(transformResult("get_ticket", err), err);
  const text = { content: [{ type: "text", text: "not json" }] };
  assert.deepEqual(transformResult("get_ticket", text), text);
  const other = { content: [{ type: "text", text: '{"_url":"http://x/REST/2.0/lifecycle/a"}' }] };
  assert.equal(transformResult("get_lifecycle", other), other);
  const done = transformResult("get_queue", { content: [{ type: "text", text: JSON.stringify(fixture("get_queue")) }] });
  assert.equal(JSON.parse(done.content[0].text).Name, "General");
});

test("tool descriptions and argument defaults", () => {
  const list = transformToolList({ tools: [{ name: "get_attachment", description: "old" }, { name: "get_ticket", description: "same" }] });
  assert.match(list.tools[0].description, /Binary content .* is not returned/);
  assert.equal(list.tools[1].description, "same");
  assert.deepEqual(applyArgumentDefaults("get_ticket", { id: 1 }), { id: 1, subfields: { Queue: "Name" } });
  assert.deepEqual(applyArgumentDefaults("get_ticket", { id: 1, subfields: { Owner: "Name" } }), { id: 1, subfields: { Owner: "Name" } });
  assert.deepEqual(applyArgumentDefaults("get_ticket_attachments", { id: 1, per_page: 5 }), { id: 1, per_page: 5 });
  assert.deepEqual(applyArgumentDefaults("search_tickets", { query: "x" }), { query: "x" });
});
