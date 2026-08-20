import type { JsonLdNode } from "@/lib/seo";

/**
 * Emits a schema.org graph as a JSON-LD script tag.
 *
 * `<` is escaped so a string in the graph can never close the script element
 * early; JSON.stringify alone does not do that.
 */
export function JsonLd({ data }: { data: JsonLdNode }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}
