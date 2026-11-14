// Zweifel an der Namens-Einordnung: eine Namens-Einordnung, der die Beschreibung des Tools
// widerspricht, wird sichtbar gemacht. Die Klasse selbst aendert sich nie.
import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyUpstreamTool } from "../src/proxy/interceptor.js";
import { classificationDoubt } from "../src/proxy/classification-doubt.js";

const cfg = { writeToolPatterns: [] as string[], readToolPatterns: [] as string[] };

function tool(name: string, description?: string, annotations?: Tool["annotations"]): Tool {
  return { name, description, inputSchema: { type: "object", properties: {} }, ...(annotations ? { annotations } : {}) };
}

describe("Zweifel an der Namens-Einordnung", () => {
  describe("ein Read dem Namen nach, dessen Beschreibung schreibt", () => {
    it("check_in_guest: «Checks a guest in and bills the first night»", () => {
      // Seit 0.11.0 fängt die Einordnung selbst das schwache Lese-Präfix «check» + Schreib-Verb ab
      // (vorher: Read mit Zweifel). Der Zweifel bleibt für die übrigen Präfixe, siehe unten.
      const c = classifyUpstreamTool(tool("check_in_guest", "Checks a guest in and bills the first night."), cfg);
      expect(c).toMatchObject({ class: "write", source: "verb word after a weak read prefix", guess: true });
    });

    it.each([
      ["get_customer", "Returns the customer, or creates one if none exists."],
      ["fetch_report", "Fetches the report and sends it to the customer."],
      ["list_stale", "Lists bookings and cancels the oldest."],
      ["verify_payment", "Verifies a payment and stores the result."],
    ])("%s", (name, description) => {
      const c = classifyUpstreamTool(tool(name, description), cfg);
      expect(c.doubt, name).toBeDefined();
    });

    it("kein Alarm bei echten Reads", () => {
      for (const [name, description] of [
        ["get_booking", "Reads a booking by guest name."],
        ["list_bookings", "Lists all bookings, most recently updated first."],
        ["get_invoice", "Returns the invoice that was created for an order."], // Partizip, kein Praesens
        ["search_orders", "Searches orders by customer. Returns at most 50 rows."],
        ["describe_table", "Describes a table. Does not modify anything."],
        ["get_quote", "Calculates a quote. Never writes or sends anything."], // Verneinung
        ["check_stock", "Checks the stock without modifying it."],
      ] as const) {
        const c = classifyUpstreamTool(tool(name, description), cfg);
        expect(c.class, name).toBe("read");
        expect(c.doubt, name).toBeUndefined();
      }
    });

    it("Parameterhinweise («Parameter guest creates a filter») sind kein Verb des Tools", () => {
      const c = classifyUpstreamTool(
        tool("get_booking", "Reads a booking. Returns the booking as JSON. Parameter guest creates a filter. Sends nothing."),
        cfg,
      );
      expect(c.doubt).toBeUndefined();
    });

    it("deutsche Beschreibung", () => {
      expect(classifyUpstreamTool(tool("check_gast", "Prüft den Gast und bucht die erste Nacht."), cfg).doubt).toContain("bucht");
      expect(classifyUpstreamTool(tool("check_gast", "Prüft den Gast, ohne etwas zu buchen."), cfg).doubt).toBeUndefined();
    });
  });

  describe("Umlaute am Wortrand", () => {
    it("«überweist» und «löscht» werden erkannt (\b kennt nur ASCII)", () => {
      expect(classifyUpstreamTool(tool("check_konto", "Prüft das Konto und überweist den Betrag."), cfg).doubt).toContain("überweist");
      expect(classifyUpstreamTool(tool("get_konto", "Liest das Konto und löscht Altbestände."), cfg).doubt).toContain("löscht");
    });
  });

  describe("ein Write dem Namen nach, dessen Beschreibung nur liest", () => {
    it("update_status_view: «Refreshes the status view (read only)»", () => {
      const c = classifyUpstreamTool(tool("update_status_view", "Refreshes the status view (read only)."), cfg);
      expect(c.class).toBe("write");
      expect(c.doubt).toContain("only reads");
    });
    it("kein Alarm bei einem echten Write", () => {
      const c = classifyUpstreamTool(tool("update_booking", "Updates a booking."), cfg);
      expect(c.doubt).toBeUndefined();
    });
  });

  describe("Befund P5/9 der Pruefrunde: Fehlalarme, Luecken, Laufzeit", () => {
    const doubt = (name: string, d: string) => classifyUpstreamTool(tool(name, d), cfg).doubt;

    it("Woerter, die auch Substantive sind, loesen nur an Verbstelle aus", () => {
      for (const d of [
        "Lists issues.", "Lists stores in the region.", "Returns charges for the period.",
        "Returns posts for a schedule.", "Lists bookings the user updates.", "Returns the invoice that bills the customer.",
        "Returns the booking that updates the calendar view.", "Shows the logs and the marks of an exam.",
      ]) {
        expect(doubt("get_thing", d), d).toBeUndefined();
      }
    });

    it("bekannte Grenze: eine Aufzaehlung von Substantiven («Returns posts and schedules») sieht aus wie ein Verb nach «and»", () => {
      expect(doubt("get_thing", "Returns posts and schedules.")).toContain("schedules");
    });

    it("Verneinung gilt fuer die ganze Aufzaehlung, nicht nur fuer die naechsten Woerter", () => {
      for (const d of [
        "Never writes, deletes or sends anything.", "Sendet nichts, löscht nichts, ändert nichts.",
        "Liefert die Buchung und bucht nichts.", "Returns the data and does nothing else.",
      ]) {
        expect(doubt("get_thing", d), d).toBeUndefined();
      }
    });

    it("ein Semikolon beendet die Verneinung: «Does not list items; creates a booking»", () => {
      expect(doubt("get_thing", "Does not list items; creates a booking.")).toContain("creates");
      expect(doubt("get_thing", "Never use this to write data; it creates a booking.")).toBeUndefined(); // «it» steht vor dem Verb
    });

    it("weitere Verben, auch nach «Also» und nach einer Abkuerzung mit Punkt", () => {
      expect(doubt("get_thing", "Gets a booking (e.g. for 2 nights). Also bills the guest.")).toContain("bills");
      for (const d of ["Returns the record and logs the access.", "Zeigt den Eintrag und schickt eine Mail.", "Liest und versendet das Dokument.", "Returns it and increments the counter."]) {
        expect(doubt("get_thing", d), d).toBeDefined();
      }
    });

    it("ein Write mit «read-only» im Parametertext ist kein Zweifel; nur der erste Satz zaehlt", () => {
      expect(doubt("update_booking", "Updates a booking. The id field is read-only.")).toBeUndefined();
      expect(doubt("update_booking", "Updates a booking. Does not change the id.")).toBeUndefined();
      expect(doubt("update_status_view", "Refreshes the view. Has no side effects.")).toBeUndefined();
      expect(doubt("update_status_view", "Read-only view refresh.")).toContain("only reads");
    });

    it("Laufzeit: eine sehr lange Beschreibung vom Upstream haelt den Start nicht auf", () => {
      for (const unit of ["not creates ", "never a creates ", "and not bills, ", "x".repeat(50) + " "]) {
        const long = unit.repeat(Math.ceil(300_000 / unit.length));
        const t0 = performance.now();
        classifyUpstreamTool(tool("get_thing", long), cfg);
        classifyUpstreamTool(tool("update_thing", long), cfg);
        expect(performance.now() - t0, unit).toBeLessThan(200);
      }
    });
  });

  describe("was der Aufrufer festgelegt hat, wird nicht angezweifelt", () => {
    it("Annotation readOnlyHint", () => {
      const c = classifyUpstreamTool(tool("check_in_guest", "Checks a guest in and bills the first night.", { readOnlyHint: true }), cfg);
      expect(c.doubt).toBeUndefined();
    });
    it("--write-tools und --read-tools", () => {
      const w = classifyUpstreamTool(tool("update_status_view", "Refreshes the view (read only)."), { ...cfg, writeToolPatterns: ["update_*"] });
      expect(w.doubt).toBeUndefined();
      const r = classifyUpstreamTool(tool("check_in_guest", "Checks in and bills."), { ...cfg, readToolPatterns: ["check_*"] });
      expect(r.doubt).toBeUndefined();
    });
    it("ohne Beschreibung gibt es nichts anzuzweifeln", () => {
      expect(classificationDoubt(tool("check_in_guest"), "read", "read prefix")).toBeUndefined();
    });
    it("nicht eingeordnete Tools werden schon als solche gemeldet, nicht zusaetzlich angezweifelt", () => {
      const c = classifyUpstreamTool(tool("process_order", "Processes an order and charges it."), cfg);
      expect(c.class).toBe("unclassified");
      expect(c.doubt).toBeUndefined();
    });
  });
});
