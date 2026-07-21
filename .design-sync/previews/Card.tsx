import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  Button,
  Badge,
} from "tasfer";

export function Basic() {
  return (
    <Card style={{ width: 340 }}>
      <CardHeader>
        <CardTitle>Weekly digest</CardTitle>
        <CardDescription>
          A summary of everything that changed in your workspace this week.
        </CardDescription>
      </CardHeader>
      <CardContent style={{ color: "var(--muted-foreground)" }}>
        14 documents edited · 3 new collaborators · 2 pages published.
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button size="sm">Open report</Button>
        <Button size="sm" variant="ghost">
          Later
        </Button>
      </CardFooter>
    </Card>
  );
}

export function WithAction() {
  return (
    <Card style={{ width: 340 }}>
      <CardHeader>
        <CardTitle>Shared canvas</CardTitle>
        <CardDescription>Anyone with the link can edit.</CardDescription>
        <CardAction>
          <Badge variant="secondary">Live</Badge>
        </CardAction>
      </CardHeader>
      <CardContent style={{ color: "var(--muted-foreground)" }}>
        Changes sync peer-to-peer — no server sees your content.
      </CardContent>
    </Card>
  );
}

export function Small() {
  return (
    <Card size="sm" style={{ width: 300 }}>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>1.2 GB of 5 GB used</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button size="sm" variant="outline">
          Manage
        </Button>
      </CardFooter>
    </Card>
  );
}
