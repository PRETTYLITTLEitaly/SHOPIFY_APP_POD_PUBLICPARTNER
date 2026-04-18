import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, ResourceList, ResourceItem, Text, Badge, BlockStack, InlineStack, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import fs from "fs";
import path from "path";

export const loader = async ({ request }) => {
  try {
    await authenticate.admin(request);
    const fontsDir = path.join(process.cwd(), "public", "fonts");
    
    let fonts = [];
    if (fs.existsSync(fontsDir)) {
      const files = fs.readdirSync(fontsDir);
      fonts = files.filter(f => f.endsWith(".ttf") || f.endsWith(".otf")).map(file => ({
        name: file.split(".").shift(),
        fileName: file,
        extension: file.split(".").pop()
      }));
    }
    
    return json({ fonts });
  } catch (e) {
    console.error("Loader Error in fonts:", e);
    return json({ fonts: [], error: "Impossibile caricare i font." });
  }
};

export const action = async ({ request }) => {
  return json({ success: false, error: "Upload disabilitato su Vercel. Usa GitHub per aggiungere nuovi font." });
};

export default function FontsLibrary() {
  const { fonts, error } = useLoaderData();

  return (
    <Page 
      title="Libreria Font" 
      backAction={{ content: "Dashboard", url: "/app/orders" }}
      subtitle="Visualizza i font disponibili per la personalizzazione"
    >
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Gestione via GitHub">
            Per garantire la massima stabilità su Vercel, carica i nuovi font (.ttf o .otf) direttamente nella cartella <strong>public/fonts</strong> del tuo repository GitHub. L'app si aggiornerà automaticamente.
          </Banner>
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner tone="critical">{error}</Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card padding="0">
            <ResourceList
              resourceName={{ singular: 'font', plural: 'font' }}
              items={fonts}
              emptyState={
                <div style={{ padding: "40px", textAlign: "center" }}>
                  <Text variant="bodyMd" tone="subdued">Nessun font trovato in public/fonts.</Text>
                </div>
              }
              renderItem={(item) => {
                const { name, fileName, extension } = item;
                return (
                  <ResourceItem id={fileName} verticalAlign="center">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text variant="bodyMd" fontWeight="bold">{name}</Text>
                        <Text variant="bodyXs" tone="subdued">{fileName}</Text>
                      </BlockStack>
                      <Badge tone="info">{extension.toUpperCase()}</Badge>
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
