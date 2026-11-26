// Shrinks mcp-server-rt's read-tool results, which are RT REST 2.0 responses passed through almost
// unchanged, so they use less of a client's context. Each function takes the parsed result of one
// tool and returns a smaller one. Tools not listed in TRANSFORMS are passed through untouched.
import { NodeHtmlMarkdown } from "node-html-markdown";

const UNSET_DATE = "1970-01-01T00:00:00Z";
const AUDIT_FIELDS = ["Created", "Creator", "LastUpdated", "LastUpdatedBy"];
const KEPT_HEADERS = /^(From|To|Cc|Date|Subject|Reply-To):/i;
const EMAIL_RECORDS = new Set(["EmailRecord", "CommentEmailRecord"]);
// Longest message or text attachment returned inside get_transaction; get_attachment returns all of it.
export const MAX_TEXT = 20000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isEmpty = (v) => v === null || v === undefined || v === "" || v === UNSET_DATE
  || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);

// A reference to another record, e.g. {"type":"user","id":"bob","_url":".../user/bob"}, optionally
// with its name. Returned as the name, or the id when there is none. A _hyperlinks entry is only a
// reference when its ref just repeats its type; "refers-to", "lifecycle" and the like carry meaning.
function referenceValue(o) {
  if (!("type" in o && "id" in o)) return undefined;
  if ("ref" in o && o.ref !== o.type) return undefined;
  const allowed = ["type", "id", "_url", "Name", "name", "ref"];
  if (!Object.keys(o).every((k) => allowed.includes(k))) return undefined;
  return o.Name ?? o.name ?? o.id;
}

// Applied to every transformed result: drops REST API URLs (the agent cannot use them; ticket links
// that mcp-server-rt has already turned into web UI links are kept), collapses references, drops the
// record-type and page-size bookkeeping, and drops empty and unset values.
export function generic(value) {
  if (Array.isArray(value)) return value.map(generic).filter((v) => !isEmpty(v));
  if (!isObject(value)) return value;
  const ref = referenceValue(value);
  if (ref !== undefined) return ref;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "type" || key === "per_page" || key === "count") continue;
    if (["_url", "next_page", "prev_page"].includes(key) && typeof v === "string" && v.includes("/REST/2.0/")) continue;
    const g = generic(v);
    if (!isEmpty(g)) out[key] = g;
  }
  return out;
}

const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const keptHeaders = (headers) => (headers ?? "").split("\n").filter((h) => KEPT_HEADERS.test(h)).join("\n");
const parentId = (a) => String(a.Parent?.id ?? a.Parent);

// Markdown keeps what plain text loses: link targets, table columns and which lines are quoted.
// Images are left out; in mail they are logos and tracking pixels, as cid: or data: URLs.
const markdown = new NodeHtmlMarkdown({ ignore: ["img", "style", "script"], maxConsecutiveNewlines: 2 });
export const htmlToMarkdown = (html) => markdown.translate(html).trim();

// Attachment content: binary is replaced by a note (base64 is unreadable to a model and can run to
// hundreds of kilobytes), HTML is converted to markdown, and text over `limit` characters is cut short.
function content(a, limit) {
  let { Content: c, ContentType: type = "" } = a;
  if (typeof c !== "string" || c === "") return {};
  if (!type.startsWith("text/")) {
    let bytes;
    try { bytes = Buffer.from(c, "base64").length; } catch { bytes = c.length; }
    return { Content: `[${type || "binary"} content not shown, ${bytes} bytes]` };
  }
  const out = {};
  if (type.startsWith("text/html")) {
    c = htmlToMarkdown(c);
    out.ContentType = `${type.split(";")[0]}, converted to markdown`;
  }
  if (c.length > limit) c = `${c.slice(0, limit)}\n[truncated: ${c.length} characters in all; get_attachment with id ${a.id} returns everything]`;
  out.Content = c;
  return out;
}

function getTransaction(txn) {
  const parts = txn.Attachments ?? [];
  // The message's own headers are on its outermost part, usually an empty multipart container.
  const top = parts.find((a) => parentId(a) === "0");
  // An HTML part is dropped when a plain-text alternative to it exists.
  const alternatives = new Set(parts.filter((a) => a.ContentType?.startsWith("multipart/alternative")).map((a) => String(a.id)));
  const withPlain = new Set(parts.filter((a) => a.ContentType?.startsWith("text/plain") && alternatives.has(parentId(a))).map(parentId));
  const kept = parts
    .filter((a) => !a.ContentType?.startsWith("multipart/"))
    .filter((a) => !(a.ContentType?.startsWith("text/html") && withPlain.has(parentId(a))))
    .map((a) => ({ id: a.id, ContentType: a.ContentType, Filename: a.Filename, ...content(a, MAX_TEXT) }));
  const { Object: object, ...rest } = omit(txn, ["_hyperlinks", "Attachments"]);
  return generic({
    ...(object?.type === "ticket" ? { Ticket: object.id } : { Object: object }),
    ...rest,
    Headers: keptHeaders(top?.Headers),
    Attachments: kept,
  });
}

function getTicket(ticket) {
  const self = (ticket._hyperlinks ?? []).find((l) => l.ref === "self");
  // Keep only the links that mean something to the agent: ticket links (refers-to, parent, ...) and
  // the lifecycle's status transitions, which mcp-server-rt's instructions tell the agent to read.
  const links = (ticket._hyperlinks ?? [])
    .filter((l) => !["self", "history", "correspond", "comment", "customfield"].includes(l.ref))
    .map((l) => (l.ref === "lifecycle" ? omit(l, ["_url"]) : l));
  const customFields = {};
  for (const cf of ticket.CustomFields ?? []) {
    const values = cf.values ?? [];
    if (values.length) customFields[cf.name] = values.length === 1 ? values[0] : values;
  }
  const rest = omit(ticket, ["_hyperlinks", "CustomFields"]);
  if (String(rest.EffectiveId?.id ?? rest.EffectiveId) === String(ticket.id)) delete rest.EffectiveId;
  for (const k of ["TimeEstimated", "TimeWorked", "TimeLeft"]) if (rest[k] === "0") delete rest[k];
  return generic({ ...rest, _url: self?._url, CustomFields: customFields, _hyperlinks: links });
}

function getTicketHistory(page) {
  if (!Array.isArray(page.items)) return generic(page);
  const items = page.items.filter((i) => !EMAIL_RECORDS.has(i.Type));
  const hidden = page.items.length - items.length;
  return generic({ ...page, items, ...(hidden ? { HiddenEmailRecords: hidden } : {}) });
}

function getTicketAttachments(page) {
  if (!Array.isArray(page.items)) return generic(page);
  let items = page.items;
  let omitted = 0;
  // Unless the caller left Filename out of `fields`, list only files: the rest are message bodies
  // and multipart containers, which get_transaction shows in context.
  if (items.some((i) => "Filename" in i)) {
    items = items.filter((i) => i.Filename);
    omitted = page.items.length - items.length;
  }
  items = items.map((i) => ("Content" in i ? { ...i, ...content(i, MAX_TEXT) } : i));
  return generic({ ...page, items, ...(omitted ? { OmittedMessageParts: omitted } : {}) });
}

function getAttachment(a) {
  return generic({
    ...omit(a, ["_hyperlinks", "MessageId", "Parent", ...AUDIT_FIELDS]),
    Headers: keptHeaders(a.Headers),
    ...content(a, Infinity),
  });
}

function customField(cf) {
  const out = omit(cf, ["_hyperlinks", "SortOrder", "LookupType", ...AUDIT_FIELDS]);
  for (const k of ["Disabled", "UniqueValues"]) if (out[k] === "0") delete out[k];
  return generic(out);
}

function getQueueFields(r) {
  const out = { ...r };
  for (const k of ["CustomFields", "QueueCustomFields", "TransactionCustomFields"]) {
    if (Array.isArray(r[k])) out[k] = r[k].map(customField);
  }
  return out;
}

export const TRANSFORMS = {
  get_transaction: getTransaction,
  get_ticket: getTicket,
  get_ticket_history: getTicketHistory,
  get_ticket_attachments: getTicketAttachments,
  get_attachment: getAttachment,
  get_queue: (q) => generic(omit(q, ["_hyperlinks", ...AUDIT_FIELDS])),
  get_queue_fields: getQueueFields,
  search_tickets: generic,
  lookup_user: generic,
  list_queues: generic,
};

// Defaults added to a tool call's arguments when the caller did not set them.
export const ARGUMENT_DEFAULTS = {
  // Without this get_ticket gives the queue only as a number.
  get_ticket: { subfields: { Queue: "Name" } },
  // Files are listed among every MIME part; a bigger page keeps them on one page once the rest are dropped.
  get_ticket_attachments: { per_page: 100 },
};

// Tool descriptions updated to match what the transforms return.
export const DESCRIPTIONS = {
  get_transaction: (d) => `${d} Message bodies are returned as text: an HTML part is left out when a plain-text version exists and converted to markdown when not, and a body over ${MAX_TEXT} characters is cut short (get_attachment returns all of it). Binary attachments are listed without their content. Only the From, To, Cc, Date, Subject and Reply-To headers are kept.`,
  get_ticket_history: (d) => `${d} Records of the notification emails RT itself sent (EmailRecord, CommentEmailRecord) are left out and counted in HiddenEmailRecords, so a page can hold fewer entries than per_page.`,
  get_ticket_attachments: () => "List the files attached to a ticket (names, MIME types, sizes, IDs). Message bodies and multipart containers are left out and counted in OmittedMessageParts; read messages with get_transaction.",
  get_attachment: () => "Retrieve a single attachment by ID. Text is returned in full, with HTML converted to markdown. Binary content (PDFs, images and the like) is not returned, only its type and size. Use get_ticket_attachments or get_transaction to find attachment IDs.",
};

// Returns the tool result with each JSON text block transformed. Errors and anything that is not
// JSON are returned as they are.
export function transformResult(tool, result) {
  const transform = TRANSFORMS[tool];
  if (!transform || !result || result.isError || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((block) => {
      if (block.type !== "text") return block;
      let data;
      try { data = JSON.parse(block.text); } catch { return block; }
      if (!isObject(data)) return block;
      return { ...block, text: JSON.stringify(transform(data)) };
    }),
  };
}

export function transformToolList(result) {
  if (!Array.isArray(result?.tools)) return result;
  return {
    ...result,
    tools: result.tools.map((t) => (DESCRIPTIONS[t.name] ? { ...t, description: DESCRIPTIONS[t.name](t.description ?? "") } : t)),
  };
}

export function applyArgumentDefaults(tool, args = {}) {
  const defaults = ARGUMENT_DEFAULTS[tool];
  if (!defaults) return args;
  const out = { ...args };
  for (const [k, v] of Object.entries(defaults)) if (out[k] === undefined) out[k] = v;
  return out;
}
