import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  ResourceList,
  ResourceItem,
  Text,
  Thumbnail,
  InlineStack,
  BlockStack,
  TextField,
  Button,
  Modal,
  Badge,
  Filters,
  OptionList
} from "@shopify/polaris";
import { useState, useCallback, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const vendor = url.searchParams.get("vendor");
  const status = url.searchParams.get("status") || "active";
  const query = url.searchParams.get("query");

  let q = `status:${status}`;
  if (vendor) q += ` vendor:"${vendor}"`;
  if (query) q += ` title:*${query}*`;

  const response = await admin.graphql(
    `#graphql
    query getProducts($q: String) {
      products(first: 50, query: $q, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          title
          vendor
          featuredImage { url }
          metafields(first: 10, namespace: "pod") {
            nodes {
              key
              value
              reference {
                ... on GenericFile { url }
                ... on MediaImage { 
                  image { url width height } 
                }
              }
            }
          }
        }
      }
      shop {
        productVendors(first: 50) {
          nodes
        }
      }
    }`,
    { variables: { q } }
  );

  const data = await response.json();
  const products = data.data.products.nodes;
  const vendors = data.data.shop.productVendors.nodes;

  const processedProducts = await Promise.all(products.map(async (product) => {
    const metafields = product.metafields.nodes || [];
    const svgMeta = metafields.find(m => m.key === "svg");
    const svgUrl = svgMeta?.reference?.url || svgMeta?.reference?.image?.url;
    const mediaImage = svgMeta?.reference?.image;
    
    let ratio = 1;
    let intrinsicW = "";
    let intrinsicH = "";

    if (mediaImage && mediaImage.width && mediaImage.height) {
      ratio = mediaImage.width / mediaImage.height;
      intrinsicW = mediaImage.width.toString();
      intrinsicH = mediaImage.height.toString();
    } else if (svgUrl) {
      try {
        const res = await fetch(svgUrl);
        const text = await res.text();
        const vb = text.match(/viewBox=["']\s*(-?\d*\.?\d+)[,\s]+(-?\d*\.?\d+)[,\s]+(\d*\.?\d+)[,\s]+(\d*\.?\d+)\s*["']/i);
        const wMatch = text.match(/width=["'](\d*\.?\d+)(px|mm|cm|in)?["']/i);
        const hMatch = text.match(/height=["'](\d*\.?\d+)(px|mm|cm|in)?["']/i);

        let w = 0, h = 0;

        if (wMatch && hMatch) {
          w = parseFloat(wMatch[1]);
          h = parseFloat(hMatch[1]);
          // Basic unit conversion to mm if possible (approximate)
          if (wMatch[2] === "px") { w = w * 0.264583; h = h * 0.264583; }
          else if (wMatch[2] === "cm") { w = w * 10; h = h * 10; }
          else if (wMatch[2] === "in") { w = w * 25.4; h = h * 25.4; }
        } else if (vb) {
          w = parseFloat(vb[3]);
          h = parseFloat(vb[4]);
        }

        if (h > 0) {
          ratio = w / h;
          intrinsicW = w.toFixed(1);
          intrinsicH = h.toFixed(1);
        }
      } catch (e) {
        console.error("Error parsing SVG for ratio:", e);
      }
    }
    return { ...product, svgUrl, ratio, intrinsicW, intrinsicH };
  }));

  return json({ products: processedProducts, vendors });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const width = formData.get("width");
  const height = formData.get("height");

  const metafields = [];
  if (width) metafields.push({ ownerId: productId, namespace: "pod", key: "width", value: width, type: "number_decimal" });
  if (height) metafields.push({ ownerId: productId, namespace: "pod", key: "height", value: height, type: "number_decimal" });

  const response = await admin.graphql(
    `#graphql
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id value }
        userErrors { field message }
      }
    }`,
    { variables: { metafields } }
  );
  return json(await response.json());
};

function ProductItem({ product, fetcher, onPreview }) {
  const { id, title, featuredImage, svgUrl, ratio, intrinsicW, intrinsicH, vendor } = product;
  const metafields = product.metafields.nodes || [];
  const initialWidth = metafields.find(m => m.key === "width")?.value || "";
  const initialHeight = metafields.find(m => m.key === "height")?.value || "";

  // Inizializzazione unica allo stato iniziale
  const [localW, setLocalW] = useState(initialWidth || (!initialWidth && intrinsicW ? intrinsicW : ""));
  const [localH, setLocalH] = useState(initialHeight || (!initialWidth && intrinsicH ? intrinsicH : ""));

  // Sincronizza SOLO se id cambia (cambio prodotto nella riga)
  useEffect(() => {
    setLocalW(initialWidth || (!initialWidth && intrinsicW ? intrinsicW : ""));
    setLocalH(initialHeight || (!initialWidth && intrinsicH ? intrinsicH : ""));
  }, [id, initialWidth, intrinsicW, intrinsicH]);

  const handleUpdate = (w, h) => {
    const fd = new FormData();
    fd.append("productId", id);
    fd.append("width", w || "");
    fd.append("height", h || "");
    fetcher.submit(fd, { method: "POST" });
  };

  const isSaving = fetcher.state !== "idle" && fetcher.formData?.get("productId") === id;

  return (
    <ResourceItem id={id} verticalAlign="center">
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="400" blockAlign="center">
          <Thumbnail source={featuredImage?.url || ""} alt={title} size="large" />
          <BlockStack gap="100">
            <Text variant="bodyMd" fontWeight="bold">{title}</Text>
            <Text variant="bodySm" tone="subdued">Venditore: {vendor}</Text>
            {svgUrl ? (
              <InlineStack gap="200" blockAlign="center">
                <Button variant="plain" onClick={() => onPreview({ url: svgUrl, title })}>
                  👁️ Vedi Anteprima
                </Button>
                {isSaving && <Badge tone="info">Salvataggio...</Badge>}
                {!initialWidth && intrinsicW && <Badge tone="attention">Dim. suggerite</Badge>}
              </InlineStack>
            ) : (
              <Badge tone="warning">Nessun SVG</Badge>
            )}
          </BlockStack>
        </InlineStack>
        {svgUrl && (
          <div style={{ minWidth: "280px" }}>
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="Larghezza" suffix="mm" value={localW} type="text" inputMode="decimal"
                  onChange={(val) => {
                    const cleanVal = val.replace(/,/g, '.').replace(/[^0-9.]/g, '');
                    setLocalW(cleanVal); 
                    
                    if (cleanVal === "") {
                      setLocalH("");
                      return;
                    }
                    
                    const num = parseFloat(cleanVal);
                    if (!isNaN(num) && ratio) {
                      setLocalH((num / ratio).toFixed(1));
                    }
                  }}
                  onBlur={() => {
                    if (localW !== initialWidth || localH !== initialHeight) {
                      handleUpdate(localW, localH);
                    }
                  }}
                  autoComplete="off"
                />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="Altezza" suffix="mm" value={localH} type="text" inputMode="decimal"
                  onChange={(val) => {
                    const cleanVal = val.replace(/,/g, '.').replace(/[^0-9.]/g, '');
                    setLocalH(cleanVal); 
                    
                    if (cleanVal === "") {
                      setLocalW("");
                      return;
                    }
                    
                    const num = parseFloat(cleanVal);
                    if (!isNaN(num) && ratio) {
                      setLocalW((num * ratio).toFixed(1));
                    }
                  }}
                  onBlur={() => {
                    if (localW !== initialWidth || localH !== initialHeight) {
                      handleUpdate(localW, localH);
                    }
                  }}
                  autoComplete="off"
                />
              </div>
            </InlineStack>
            {!initialWidth && localW && (
              <div style={{ marginTop: "4px" }}>
                <Button variant="plain" size="micro" onClick={() => handleUpdate(localW, localH)}>
                  Salva dimensioni suggerite
                </Button>
              </div>
            )}
          </div>
        )}
      </InlineStack>
    </ResourceItem>
  );
}

export default function Catalog() {
  const { products, vendors } = useLoaderData();
  const fetcher = useFetcher();
  const [activePreview, setActivePreview] = useState(null);
  const navigate = useNavigate();
  const [queryValue, setQueryValue] = useState("");
  const [vendorSelected, setVendorSelected] = useState([]);
  const [statusSelected, setStatusSelected] = useState(["active"]);

  const handleFiltersChange = (q, v, s) => {
    const p = new URLSearchParams();
    if (q) p.set("query", q);
    if (v?.length > 0) p.set("vendor", v[0]);
    if (s?.length > 0) p.set("status", s[0]);
    navigate(`/app/catalog?${p.toString()}`);
  };

  const filters = [
    {
      key: "vendor", label: "Venditore",
      filter: (
        <OptionList title="Venditore" options={vendors.map(v => ({ label: v, value: v }))}
          selected={vendorSelected}
          onChange={(v) => { setVendorSelected(v); handleFiltersChange(queryValue, v, statusSelected); }}
        />
      ),
      shortcut: true,
    },
    {
      key: "status", label: "Stato",
      filter: (
        <OptionList title="Stato"
          options={[{ label: "Attivo", value: "active" }, { label: "Bozza", value: "draft" }, { label: "Archiviato", value: "archived" }]}
          selected={statusSelected}
          onChange={(s) => { setStatusSelected(s); handleFiltersChange(queryValue, vendorSelected, s); }}
        />
      ),
      shortcut: true,
    },
  ];

  const toggleModal = useCallback(() => setActivePreview(null), []);

  return (
    <Page title="GESTIONE GRAFICHE DTF" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <ResourceList resourceName={{ singular: "prodotto", plural: "prodotti" }}
              items={products}
              filterControl={
                <Filters queryValue={queryValue} filters={filters}
                  onQueryChange={(val) => setQueryValue(val)}
                  onQueryClear={() => setQueryValue("")}
                  onClearAll={() => navigate("/app/catalog")}
                  onSubmit={() => handleFiltersChange(queryValue, vendorSelected, statusSelected)}
                />
              }
              renderItem={(p) => <ProductItem product={p} fetcher={fetcher} onPreview={setActivePreview} />}
            />
          </Card>
        </Layout.Section>
      </Layout>
      {activePreview && (
        <Modal open={true} onClose={toggleModal} title={`Anteprima: ${activePreview.title}`} 
               primaryAction={{ content: "Chiudi", onClick: toggleModal }}>
          <Modal.Section>
            <div style={{ textAlign: "center", backgroundColor: "#f1f1f1", padding: "20px", borderRadius: "8px" }}>
              <img src={activePreview.url} alt="SVG" style={{ maxWidth: "100%", maxHeight: "500px", objectFit: "contain" }} />
            </div>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
