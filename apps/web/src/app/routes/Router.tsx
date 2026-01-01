import React from "react";
import { Navigate, useRoutes } from "react-router-dom";
import Layout from "../layout/Layout";

const EditorPage = React.lazy(() => import("../pages/EditorPage"));

export default function Router() {
  return useRoutes([
    {
      path: "/",
      element: <Layout />,
      children: [
        {
          index: true,
          element: <Navigate to="/page" replace />,
        },
        {
          path: "page/:id",
          element: <EditorPage />,
        },
        {
          path: "page",
          element: <EditorPage />,
        },
      ],
    },
    {
      path: "*",
      element: <Navigate to="/" replace />,
    },
  ]);
}

