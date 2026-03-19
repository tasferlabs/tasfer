import React from "react";
import { Navigate, createBrowserRouter } from "react-router-dom";
import Layout from "../layout/Layout";
import { RequireAuth, RequireOnboarding, RedirectIfAuthed } from "./AuthGuard";

function RestoreLastRoute() {
  const lastRoute = localStorage.getItem("lastRoute") || "/page";
  return <Navigate to={lastRoute} replace />;
}

const EditorPage = React.lazy(() => import("../pages/EditorPage"));
const CalendarPage = React.lazy(
  () => import("../pages/CalendarPage/CalendarPage"),
);
const SettingsPage = React.lazy(
  () => import("../pages/SettingsPage/SettingsPage"),
);
const LoginPage = React.lazy(() => import("../pages/LoginPage"));
const RegisterPage = React.lazy(() => import("../pages/RegisterPage"));
const VerifyEmailPage = React.lazy(() => import("../pages/VerifyEmailPage"));
const ForgotPasswordPage = React.lazy(
  () => import("../pages/ForgotPasswordPage"),
);
const ResetPasswordPage = React.lazy(
  () => import("../pages/ResetPasswordPage"),
);
const VerifyEmailChangePage = React.lazy(
  () => import("../pages/VerifyEmailChangePage"),
);
const OnboardingPage = React.lazy(() => import("../pages/OnboardingPage"));
const HomePage = React.lazy(() => import("../pages/HomePage/HomePage"));

export const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <RedirectIfAuthed>
        <LoginPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: "/register",
    element: (
      <RedirectIfAuthed>
        <RegisterPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: "/verify-email",
    element: (
      <RedirectIfAuthed>
        <VerifyEmailPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: "/forgot-password",
    element: (
      <RedirectIfAuthed>
        <ForgotPasswordPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: "/reset-password",
    element: (
      <RedirectIfAuthed>
        <ResetPasswordPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: "/verify-email-change",
    element: <VerifyEmailChangePage />,
  },
  {
    path: "/onboarding",
    element: (
      <RequireOnboarding>
        <OnboardingPage />
      </RequireOnboarding>
    ),
  },
  {
    path: "/",
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      {
        index: true,
        element: <RestoreLastRoute />,
      },
      {
        path: "page/:id",
        element: <EditorPage />,
      },
      {
        path: "page",
        element: <EditorPage />,
      },
      {
        path: "calendar",
        element: <CalendarPage />,
      },
      {
        path: "settings",
        element: <SettingsPage />,
      },
    ],
  },
  {
    path: "/home",
    element: (
      // <RedirectIfAuthed>
      <HomePage />
      // </RedirectIfAuthed>
    ),
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
