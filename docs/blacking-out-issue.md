# Blacking Out Issue

When we release a new update for our web application, there are certain scenarios that can lead to a poor user experience, such as users encountering broken pages or outdated content. To mitigate these issues, we need to implement strategies to handle updates effectively.
- If there is new update while we in app, we should @apps/web/src/app/pages/ForceUpdatePage.tsx or
  @apps/web/src/app/components/UpdatePopup.tsx depending on the existing logic. If we update the app should update correctly.
- When the app in background and we release new update and should refetch new resources. We should never leave the app in broken
  phase, where half of the files are missing and we caching index html pointing to old assets
