import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  Input,
} from "tasfer";
import { useForm } from "react-hook-form";
import { useEffect } from "react";

export function Basic() {
  const form = useForm({
    defaultValues: {
      name: "Product roadmap",
      email: "alex@tasfer.app",
    },
  });

  return (
    <Form {...form}>
      <form
        style={{ width: 340, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Document name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormDescription>
                Everyone with access sees this name.
              </FormDescription>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Invite collaborator</FormLabel>
              <FormControl>
                <Input type="email" {...field} />
              </FormControl>
              <FormDescription>They can edit this canvas in real time.</FormDescription>
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}

export function Invalid() {
  const form = useForm({
    defaultValues: { email: "alex@tasfer" },
  });

  useEffect(() => {
    form.setError("email", { message: "Enter a valid email address." });
  }, [form]);

  return (
    <Form {...form}>
      <form style={{ width: 340 }}>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Invite collaborator</FormLabel>
              <FormControl>
                <Input type="email" {...field} />
              </FormControl>
              <FormDescription>They can edit this canvas in real time.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}
