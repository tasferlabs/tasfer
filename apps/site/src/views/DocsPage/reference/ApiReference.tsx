"use client";

import dynamic from "next/dynamic";

/* The reference is the one article that carries real weight: the data for the
 * default package alone is several hundred kilobytes. Every docs article is
 * imported by the nav, so loading the view directly would put that data in the
 * bundle of every docs page. `dynamic` splits it into its own chunk — still
 * prerendered into this page's HTML, fetched by no other page. */
const ApiReferenceView = dynamic(() => import("./ApiReferenceView"));

export function ApiReference() {
  return <ApiReferenceView />;
}
