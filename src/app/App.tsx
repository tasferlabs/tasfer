import React from "react";
import { ScrollableEditor } from "./ScrollableEditor";
import Layout from "./layout/Layout";

const App: React.FC = () => {
  return (
    <Layout>
      <ScrollableEditor path="/sample.md" className="w-full h-full" />
    </Layout>
  );
};

export default App;
