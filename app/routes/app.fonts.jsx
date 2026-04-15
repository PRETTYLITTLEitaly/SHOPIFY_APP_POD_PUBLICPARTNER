import { json, unstable_parseMultipartFormData, unstable_createFileUploadHandler } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Layout, Card, ResourceList, ResourceItem, Text, Badge, Button, BlockStack, InlineStack, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import fs from "fs";
import path from "path";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const fontsDir = path.join(process.cwd(), "public", "fonts");
  if (!fs.existsSync(fontsDir)) fs.mkdirSync(fontsDir, { recursive: true });
  
  const files = fs.readdirSync(fontsDir);
  const fonts = files.map(file => ({
    name: file.split(".").shift(),
    fileName: file,
    extension: file.split(".").pop()
  }));
  
  return json({ fonts });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const fontsDir = path.join(process.cwd(), "public", "fonts");
  
  const uploadHandler = unstable_createFileUploadHandler({
    directory: fontsDir,
    maxPartSize: 5_000_000,
    file: ({ filename }) => filename,
  });

  const formData = await unstable_parseMultipartFormData(request, uploadHandler);
  const actionType = formData.get("actionType");

  if (actionType === "delete") {
    const fileName = formData.get("fileName");
    const filePath = path.join(fontsDir, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return json({ success: true });
  }

  return json({ success: true });
};

export default function FontsLibrary() {
  const { fonts } = useLoaderData();
  const fetcher = useFetcher();

  const handleDelete = (fileName) => {
    const formData = new FormData();
    formData.append("actionType", "delete");
    formData.append("fileName", fileName);
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <Page 
      title="Libreria Font" 
      subtitle="Gestisci i font per le grafiche Zepto (Product Personalizer)"
      backAction={{ content: "Ordini", url: "/app/orders" }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Carica Nuovo Font</Text>
              <Text variant="bodySm" tone="subdued">I file devono essere in formato .ttf o .otf</Text>
              
              <fetcher.Form method="post" encType="multipart/form-data">
                <InlineStack gap="200" align="start">
                  <input type="file" name="fontFile" accept=".ttf,.otf" style={{ padding: "8px", border: "1px solid #ccc", borderRadius: "4px" }} required />
                  <Button submit primary loading={fetcher.state === "submitting"}>Carica Font</Button>
                </InlineStack>
              </fetcher.Form>

              {fetcher.data?.success && (
                <Banner tone="success" onDismiss={() => {}}>Font caricato con successo!</Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <ResourceList
              resourceName={{ singular: 'font', plural: 'font' }}
              items={fonts}
              emptyState={
                <div style={{ padding: "40px", textAlign: "center" }}>
                  <Text variant="bodyMd" tone="subdued">Nessun font caricato. Carica il primo per iniziare!</Text>
                </div>
              }
              renderItem={(item) => {
                const { name, fileName, extension } = item;
                return (
                  <ResourceItem
                    id={fileName}
                    accessibilityLabel={`Dettagli per ${name}`}
                  >
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text variant="bodyMd" fontWeight="bold">{name}</Text>
                        <Badge tone="info">{extension.toUpperCase()}</Badge>
                      </BlockStack>
                      <Button 
                        tone="critical" 
                        variant="plain" 
                        onClick={() => handleDelete(fileName)}
                      >
                       Elimina
                      </Button>
                    </InlineStack>
                  </ResourceItem>
                );
              }}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
