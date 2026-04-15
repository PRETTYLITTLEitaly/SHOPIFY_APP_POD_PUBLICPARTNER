import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  List,
  Banner,
  InlineStack,
  Button,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  // Forza la registrazione dei Webhook per il pilota automatico
  try {
    const { registerWebhooks } = await import("../shopify.server");
    await registerWebhooks({ session });
    console.log("Webhooks registrati con successo!");
  } catch (e) {
    console.error("Errore registrazione webhooks:", e);
  }

  const response = await admin.graphql(
    `#graphql
    query getOrderStats {
      orders(first: 100, query: "fulfillment_status:unfulfilled") {
        nodes {
          printed: metafield(namespace: "pod", key: "printed") {
            value
          }
          lineItems(first: 20) {
            nodes {
              product {
                metafields(first: 5, namespace: "pod") {
                  nodes {
                    key
                    value
                    reference {
                      ... on GenericFile { url }
                      ... on MediaImage { image { url } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`
  );

  const data = await response.json();
  const allOrders = data.data?.orders?.nodes || [];

  const podOrders = allOrders.filter(order => {
    return order.lineItems?.nodes?.some(item => {
      const metafields = item.product?.metafields?.nodes || [];
      return metafields.some(m => m.key === "svg" && (m.value || m.reference));
    }) || false;
  });

  const pending = podOrders.filter(o => o.printed?.value !== "true").length;
  const printed = podOrders.filter(o => o.printed?.value === "true").length;

  return json({ pending, printed });
};

export default function Index() {
  const { pending, printed } = useLoaderData();
  const navigate = useNavigate();

  return (
    <Page>
      <TitleBar title="POD-Generator Dashboard" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Benvenuto nel tuo sistema Print on Demand! 🎉
                </Text>
                <Text variant="bodyMd" as="p">
                  Questa app ti permette di gestire l'impaginazione automatica delle tue grafiche vettoriali direttamente dagli ordini di Shopify.
                </Text>
              </BlockStack>
            </Card>

            <InlineStack gap="400">
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200" align="center">
                    <Text variant="headingLg" as="p" tone="brand">{pending}</Text>
                    <Text variant="bodyMd" tone="subdued">Da Stampare</Text>
                    <Button variant="primary" onClick={() => navigate("/app/orders")}>Ordini</Button>
                  </BlockStack>
                </Card>
              </div>
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200" align="center">
                    <Text variant="headingLg" as="p" tone="success">{printed}</Text>
                    <Text variant="bodyMd" tone="subdued">Stampati</Text>
                    <Button variant="plain" disabled>Statistiche</Button>
                  </BlockStack>
                </Card>
              </div>
              <div style={{ flex: 1 }}>
                <Card>
                  <BlockStack gap="200" align="center">
                    <Text variant="headingLg" as="p" tone="caution">🎨</Text>
                    <Text variant="bodyMd" tone="subdued">Grafiche & Anteprime</Text>
                    <Button onClick={() => navigate("/app/catalog")}>Catalogo</Button>
                  </BlockStack>
                </Card>
              </div>
            </InlineStack>

            <Card>
              <BlockStack gap="400">
                <Text variant="headingSm" as="h3">Come iniziare:</Text>
                <List>
                  <List.Item>
                    Vai nella sezione <strong>Configurazione</strong> per attivare i campi POD nel tuo catalogo.
                  </List.Item>
                  <List.Item>
                    Entra nella pagina di un <strong>Prodotto</strong> su Shopify, carica il file SVG nel campo POD e imposta le dimensioni (es. 100mm).
                  </List.Item>
                  <List.Item>
                    Vai in <strong>Ordini POD</strong>, seleziona gli ordini che vuoi stampare e clicca su "Genera PDF".
                  </List.Item>
                </List>
                
                <Banner tone="info">
                  L'app calcolerà automaticamente l'incastro migliore delle grafiche su un foglio di 30cm x 100cm per ridurre al minimo lo spreco di materiale.
                </Banner>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
