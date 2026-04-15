import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  Banner,
  BlockStack,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  // Check if definitions already exist
  const response = await admin.graphql(
    `#graphql
    query {
      metafieldDefinitions(first: 100, ownerType: PRODUCT) {
        nodes {
          namespace
          key
        }
      }
    }`
  );
  
  const data = await response.json();
  const definitions = data.data?.metafieldDefinitions?.nodes || [];
  
  const hasSvg = definitions.some(d => d.namespace === "pod" && d.key === "svg");
  const hasWidth = definitions.some(d => d.namespace === "pod" && d.key === "width");
  const hasHeight = definitions.some(d => d.namespace === "pod" && d.key === "height");

  return json({ hasSvg, hasWidth, hasHeight });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  const formData = await request.formData();
  const type = formData.get("type");

  if (type === "setup") {
    // 1. First, get IDs of existing definitions to delete them
    const checkRes = await admin.graphql(
      `#graphql
      query {
        metafieldDefinitions(first: 100, ownerType: PRODUCT) {
          nodes {
            id
            namespace
            key
          }
        }
      }`
    );
    const checkData = await checkRes.json();
    const toDelete = checkData.data?.metafieldDefinitions?.nodes?.filter(
      d => d.namespace === "pod" && (d.key === "svg" || d.key === "width" || d.key === "height")
    ) || [];

    for (const d of toDelete) {
      const delRes = await admin.graphql(
        `#graphql
        mutation metafieldDefinitionDelete($id: ID!) {
          metafieldDefinitionDelete(id: $id) {
            deletedDefinitionId
            userErrors { field message }
          }
        }`,
        { variables: { id: d.id } }
      );
      const delData = await delRes.json();
      if (delData.data?.metafieldDefinitionDelete?.userErrors?.length > 0) {
        console.error("Delete Error:", delData.data.metafieldDefinitionDelete.userErrors);
      }
    }

    // 2. Now create the new ones
    const definitions = [
      {
        name: "POD SVG File",
        namespace: "pod",
        key: "svg",
        type: "file_reference",
        ownerType: "PRODUCT",
        description: "SVG file for Print on Demand"
      },
      {
        name: "POD Width (mm)",
        namespace: "pod",
        key: "width",
        type: "number_decimal",
        ownerType: "PRODUCT",
        description: "Target width for printing in mm"
      },
      {
        name: "POD Height (mm)",
        namespace: "pod",
        key: "height",
        type: "number_decimal",
        ownerType: "PRODUCT",
        description: "Target height for printing in mm"
      }
    ];

    let errors = [];
    for (const def of definitions) {
      const createRes = await admin.graphql(
        `#graphql
        mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id name }
            userErrors { field message }
          }
        }`,
        { variables: { definition: def } }
      );
      const createData = await createRes.json();
      const userErrors = createData.data?.metafieldDefinitionCreate?.userErrors || [];
      if (userErrors.length > 0) {
        errors.push(...userErrors.map(e => e.message));
      }
    }

    if (errors.length > 0) {
      return json({ success: false, errors });
    }

    return json({ success: true });
  }

  return json({ success: false });
};

export default function Setup() {
  const { hasSvg, hasWidth, hasHeight } = useLoaderData();
  const fetcher = useFetcher();

  const isSetup = hasSvg && hasWidth && hasHeight;

  return (
    <Page title="App Setup">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Configurazione Metafields
              </Text>
              <Text as="p">
                Per permetterti di caricare gli SVG e impostare le dimensioni direttamente nella pagina prodotto, l'app deve creare dei campi personalizzati (Metafields) nel tuo store.
              </Text>
              
              {isSetup ? (
                <Banner tone="success">
                  I campi POD sono configurati correttamente! Puoi andare nella pagina di un prodotto qualsiasi e scorrere in fondo per trovarli.
                </Banner>
              ) : (
                <Banner tone="warning">
                  I campi non sono ancora configurati. Clicca il pulsante qui sotto per inizializzarli.
                </Banner>
              )}

              <fetcher.Form method="post">
                <input type="hidden" name="type" value="setup" />
                <Button 
                  submit 
                  variant="primary" 
                  loading={fetcher.state === "submitting"}
                >
                  {isSetup ? "Ripristina e Aggiorna Campi POD" : "Inizializza Campi POD"}
                </Button>
              </fetcher.Form>
              
              {isSetup && (
                <Text variant="bodySm" tone="subdued">
                  Se hai problemi a salvare i dati nei prodotti, clicca il tasto sopra per resettare i campi al formato più recente.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
