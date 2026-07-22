import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "tasfer";

export function Single() {
  return (
    <Accordion type="single" collapsible defaultValue="sync">
      <AccordionItem value="sync">
        <AccordionTrigger>How does peer-to-peer sync work?</AccordionTrigger>
        <AccordionContent className="h-auto">
          Edits are exchanged directly between connected devices over WebRTC and
          merged with a CRDT, so every peer converges on the same canvas without
          a central server.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="offline">
        <AccordionTrigger>Can I work offline?</AccordionTrigger>
        <AccordionContent className="h-auto">
          Yes. Documents are stored locally first, and changes reconcile
          automatically the next time you reconnect with a peer.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="export">
        <AccordionTrigger>What can I export?</AccordionTrigger>
        <AccordionContent className="h-auto">
          Any frame or the full canvas can be exported to PNG or SVG at up to 4x
          scale.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function Multiple() {
  return (
    <Accordion type="multiple" defaultValue={["privacy", "storage"]}>
      <AccordionItem value="privacy">
        <AccordionTrigger>Who can see my documents?</AccordionTrigger>
        <AccordionContent className="h-auto">
          Only the peers you share a link with. Content is never uploaded to
          Tasfer servers.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="storage">
        <AccordionTrigger>Where is my data stored?</AccordionTrigger>
        <AccordionContent className="h-auto">
          On your own device, in local storage. You stay in control of every
          canvas.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
