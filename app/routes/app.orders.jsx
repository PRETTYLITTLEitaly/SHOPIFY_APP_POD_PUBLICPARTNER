import { json } from "@remix-run/node";
// APP_VERSION: 1.0.4-search-ready
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  ResourceList,
  ResourceItem,
  Text,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  Checkbox,
  TextField,
  Filters,
  Modal,
  Spinner,
  Thumbnail,
  Banner,
  Frame,
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
// import { PDFDocument, rgb } from "pdf-lib";
// import { generatePodPdf } from "../lib/pod.server";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    // FORCE_BUILD_REFRESH: Sincronizzazione per ricerca ordini (#14623 ready)
    const url = new URL(request.url);
    const searchTerm = url.searchParams.get("query") || "";
    
    let gqlQuery = "status:open fulfillment_status:unfulfilled";
    if (searchTerm) {
      const cleanTerm = searchTerm.replace("#", "");
      // Sintassi ultra-semplice: status:any + numero ordine
      gqlQuery = `status:any name:${cleanTerm}`;
    }

    const response = await admin.graphql(
      `#graphql
      query getOrders($gqlQuery: String) {
        orders(first: 50, query: $gqlQuery, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
            tags
            printed: metafield(namespace: "pod", key: "printed") { value }
            approved: metafield(namespace: "pod", key: "status") { value }
            lineItems(first: 20) {
              nodes {
                id
                title
                quantity
                customAttributes { key value }
              product {
                id
                pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                pod_svg: metafield(namespace: "pod", key: "svg") { 
                  namespace key value 
                  reference {
                    ... on GenericFile { url }
                    ... on MediaImage { image { url } }
                  }
                }
                custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
              }
              variant {
                id
                pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                pod_svg: metafield(namespace: "pod", key: "svg") { 
                  namespace key value 
                  reference {
                    ... on GenericFile { url }
                    ... on MediaImage { image { url } }
                  }
                }
                custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
              }
              }
            }
          }
        }
      }`,
      { variables: { gqlQuery } }
    );

    const data = await response.json();
    if (data.errors) {
      return json({ orders: [], error: "GraphQL Error: " + JSON.stringify(data.errors) });
    }

    const allOrders = data.data?.orders?.nodes || [];
    // Se stiamo cercando, mostriamo tutto quello che Shopify ci restituisce
    // Se non stiamo cercando, filtriamo solo i POD per pulizia
    const podOrders = searchTerm ? allOrders : allOrders.filter(order => {
      const isZepto = order.tags?.includes("product-personalizer");
      const hasPodProduct = (order.lineItems?.nodes || []).some(item => {
        const metafields = [
          item.product?.pod_width, item.product?.pod_height, item.product?.pod_svg,
          item.product?.custom_url, item.product?.custom_width, item.product?.custom_height,
          item.variant?.pod_width, item.variant?.pod_height, item.variant?.pod_svg,
          item.variant?.custom_url, item.variant?.custom_width, item.variant?.custom_height
        ].filter(Boolean);
        const hasSvgStr = metafields.some(m => m.key === "svg" && (m.value || m.reference));
        const hasUrlStr = metafields.some(m => m.key === "pod_svg_url" && m.value);
        return hasSvgStr || hasUrlStr;
      });
      return isZepto || hasPodProduct;
    });

    return json({ orders: podOrders });
  } catch (err) {
    console.error("LOADER CRASH:", err);
    return json({ orders: [], error: err.message });
  }
};

export const action = async ({ request }) => {
  console.log("--- INIZIO AZIONE DOWNLOAD PDF ---");
  const { admin, session } = await authenticate.admin(request);
  console.log("Autenticazione riuscita per shop:", session.shop);

  const formData = await request.formData();
  const type = formData.get("type");

  if (type === "removeBackground") {
    const imageUrl = formData.get("imageUrl");
    const apiKey = process.env.REMOVE_BG_API_KEY;
    
    try {
      const response = await fetch("https://api.remove.bg/v1.0/removebg", {
        method: "POST",
        headers: {
          "X-Api-Key": apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          image_url: imageUrl,
          size: "auto",
          format: "png"
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return json({ success: false, error: errorData.errors?.[0]?.title || "Errore API Remove.bg" });
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return json({ success: true, base64: `data:image/png;base64,${base64}` });
    } catch (e) {
      return json({ success: false, error: "Errore server: " + e.message });
    }
  }

  if (type === "vectorizeImage") {
    const imageUrl = formData.get("imageUrl");
    // Protezione contro stringhe "undefined" (comuni se impostate male su Vercel)
    const rawId = process.env.VECTORIZER_API_ID;
    const rawSecret = process.env.VECTORIZER_API_SECRET;
    
    const apiId = (rawId && rawId !== "undefined") ? rawId : "vkb4cx74eat2jdf";
    const apiSecret = (rawSecret && rawSecret !== "undefined") ? rawSecret : "aoukfhn8mrg4jksjh490q6trht5mlom3a80eqk6kajs97619mk61";
    
    try {
      console.log("[VECTOR v1.8.2] Avvio in modalità TEST...");
      const body = new FormData();
      body.append("mode", "test"); // Richiesto Modalità Test
      
      if (imageUrl.startsWith("data:")) {
        const base64Data = imageUrl.split(",")[1];
        const blob = new Blob([Buffer.from(base64Data, "base64")], { type: "image/png" });
        body.append("image", blob, "image.png");
      } else {
        const res = await fetch(imageUrl);
        const buffer = await res.arrayBuffer();
        const blob = new Blob([buffer], { type: "image/png" });
        body.append("image", blob, "image.png");
      }

      const response = await fetch("https://it.vectorizer.ai/api/v1/vectorize", {
        method: "POST",
        headers: {
          "Authorization": "Basic " + Buffer.from(`${apiId}:${apiSecret}`).toString("base64")
        },
        body: body
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Errore Vectorizer: ${response.status} ${errText}`);
      }

      const svgBuffer = await response.arrayBuffer();
      const svgBase64 = Buffer.from(svgBuffer).toString("base64");
      return json({ success: true, base64: `data:image/svg+xml;base64,${svgBase64}`, isSvg: true });
    } catch (e) {
      console.error("[VECTOR ERROR]:", e.message);
      return json({ success: false, error: e.message });
    }
  }

  if (type === "generatePdf") {
    try {
      const selectedIds = JSON.parse(formData.get("orderIds"));
      
      // 1. FETCH TUTTI GLI ORDINI IN UN'UNICA RICHIESTA (BATCHING)
      const response = await admin.graphql(
        `#graphql
        query getBatchOrders($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              name
              tags
              status: metafield(namespace: "pod", key: "status") { value }
              edited_image: metafield(namespace: "pod", key: "edited_image") { value }
              order_width: metafield(namespace: "pod", key: "width") { value }
              order_height: metafield(namespace: "pod", key: "height") { value }
              lineItems(first: 20) {
                nodes {
                  id
                  title
                  quantity
                  customAttributes { key value }
                  product {
                    id
                    pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                    pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                    pod_svg: metafield(namespace: "pod", key: "svg") { 
                      namespace key value 
                      reference {
                        ... on GenericFile { url }
                        ... on MediaImage { image { url } }
                      }
                    }
                    custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                    custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                    custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
                  }
                  variant {
                    id
                    pod_width: metafield(namespace: "pod", key: "width") { namespace key value }
                    pod_height: metafield(namespace: "pod", key: "height") { namespace key value }
                    pod_svg: metafield(namespace: "pod", key: "svg") { 
                      namespace key value 
                      reference {
                        ... on GenericFile { url }
                        ... on MediaImage { image { url } }
                      }
                    }
                    custom_url: metafield(namespace: "custom", key: "pod_svg_url") { namespace key value }
                    custom_width: metafield(namespace: "custom", key: "width") { namespace key value }
                    custom_height: metafield(namespace: "custom", key: "height") { namespace key value }
                  }
                }
              }
            }
          }
        }`,
        { variables: { ids: selectedIds } }
      );
      const batchRes = await response.json();
      console.log("DIAGNOSTIC BATCH RES:", JSON.stringify(batchRes).substring(0, 500));
      const ordersDetails = batchRes.data?.nodes || [];

      const itemsToPack = [];
      const svgCache = new Map(); // CACHE PER NON SCARICARE DOPPIONI

      const skippedItems = [];

      for (const order of ordersDetails) {
        if (!order) continue;
        
        const isZeptoOrder = order.tags?.includes("product-personalizer");
        const editedImageMeta = order.edited_image?.value;
        const orderWidth = order.order_width?.value;
        const orderHeight = order.order_height?.value;
        
        // Verifica approvazione Zepto
        if (isZeptoOrder && order.status?.value !== "approved") {
          throw new Error(`L'ordine ${order.name} (Zepto) non è ancora stato approvato nell'app.`);
        }

        for (const item of order.lineItems.nodes) {
          const metafields = [
            item.product?.pod_width, item.product?.pod_height, item.product?.pod_svg,
            item.product?.custom_url, item.product?.custom_width, item.product?.custom_height,
            item.variant?.pod_width, item.variant?.pod_height, item.variant?.pod_svg,
            item.variant?.custom_url, item.variant?.custom_width, item.variant?.custom_height
          ].filter(Boolean);
          
          let widthVal = metafields.find(m => m.key === "width")?.value;
          let heightVal = metafields.find(m => m.key === "height")?.value;
          
          if (!widthVal || !heightVal) {
            const attrWidth = item.customAttributes?.find(a => ["Width", "Larghezza", "_pplr_width"].includes(a.key))?.value;
            const attrHeight = item.customAttributes?.find(a => ["Height", "Altezza", "_pplr_height"].includes(a.key))?.value;
            if (attrWidth) widthVal = attrWidth;
            if (attrHeight) heightVal = attrHeight;
          }

          const allMediaAttrs = item.customAttributes?.filter(a => 
            ["Immagine", "Grafica", "Grafica Personalizzata", "_pplr_original", "_pplr_pdf", "_pplr_preview", "Preview URL", "_design_Vedi ora"].includes(a.key)
          ) || [];
          
          // Cerchiamo prima i campi "puri" (senza parole come preview o design)
          const bestMedia = allMediaAttrs.find(a => 
            !a.key.toLowerCase().includes("preview") && 
            !a.key.toLowerCase().includes("design") && 
            !a.key.toLowerCase().includes("vedi")
          ) || allMediaAttrs[0];

          const zeptoAttrUrl = bestMedia?.value;
          const editedImageMeta = order.edited_image?.value;

          // SMART FALLBACK PER ZEPTO (v1.2.0)
          if ((!widthVal || !heightVal) && (isZeptoOrder || zeptoAttrUrl)) {
            widthVal = orderWidth || "80";
            heightVal = orderHeight || "100";
            console.log(`[ZEPTO FALLBACK] Misure ${widthVal}x${heightVal} per ${item.title}`);
          }
          
          // OVERRIDE MISURE DA ORDINE (v1.7.0)
          if (orderWidth && orderHeight) {
            widthVal = orderWidth;
            heightVal = orderHeight;
          }

          if (widthVal && heightVal) {
            const svgMeta = metafields.find(m => m.key === "svg");
            const svgTextUrl = metafields.find(m => m.key === "pod_svg_url" || m.key === "pod_url")?.value;
            let svgUrl = editedImageMeta || (isZeptoOrder && zeptoAttrUrl 
              ? zeptoAttrUrl 
              : (svgTextUrl || svgMeta?.reference?.url || svgMeta?.reference?.image?.url || zeptoAttrUrl));

            if (svgUrl) {
              if (svgUrl.startsWith("//")) svgUrl = "https:" + svgUrl;
              const isImage = /\.(png|jpg|jpeg|webp)$/i.test(svgUrl);
              let mediaContent = svgCache.get(svgUrl);
              
              if (!mediaContent) {
                try {
                  const mediaRes = await fetch(svgUrl);
                  if (mediaRes.ok) {
                    if (isImage) {
                      const buffer = await mediaRes.arrayBuffer();
                      mediaContent = Buffer.from(buffer).toString("base64");
                    } else {
                      mediaContent = await mediaRes.text();
                    }
                    svgCache.set(svgUrl, mediaContent);
                  }
                } catch (e) {
                  console.error("Fetch error:", e.message);
                }
              }

              if (mediaContent) {
                for (let i = 0; i < item.quantity; i++) {
                  itemsToPack.push({
                    id: `${item.id}-${i}`,
                    orderName: order.name,
                    widthMm: parseFloat(widthVal),
                    heightMm: parseFloat(heightVal),
                    svgContent: isImage ? null : mediaContent,
                    imageContent: isImage ? mediaContent : null
                  });
                }
              } else if (zeptoAttrUrl && !mediaContent) {
              // Se abbiamo l'URL ma il download è fallito, proviamo comunque a renderizzare come TESTO se presente
              const frase = item.customAttributes?.find(a => a.key === "Frase")?.value;
              const font = item.customAttributes?.find(a => a.key === "Scegli font")?.value;
              const colore = item.customAttributes?.find(a => a.key === "Scegli colore font")?.value;
              
              if (frase) {
                for (let i = 0; i < item.quantity; i++) {
                  itemsToPack.push({
                    id: `${item.id}-${i}`,
                    orderName: order.name,
                    widthMm: parseFloat(widthVal),
                    heightMm: parseFloat(heightVal),
                    textContent: frase,
                    fontName: font,
                    fontColor: colore
                  });
                }
              } else {
                skippedItems.push(`${item.title} (Grafica corrotta/mancante)`);
              }
            }
          } else {
            // Caso in cui mancano SVG ma abbiamo i dati Zepto (TESTO PURO)
            const frase = item.customAttributes?.find(a => a.key === "Frase")?.value;
            const font = item.customAttributes?.find(a => a.key === "Scegli font")?.value;
            const colore = item.customAttributes?.find(a => a.key === "Scegli colore font")?.value;
            
            if (frase) {
              for (let i = 0; i < item.quantity; i++) {
                itemsToPack.push({
                  id: `${item.id}-${i}`,
                  orderName: order.name,
                  widthMm: parseFloat(widthVal),
                  heightMm: parseFloat(heightVal),
                  textContent: frase,
                  fontName: font,
                  fontColor: colore
                });
              }
            } else {
              skippedItems.push(`${item.title} (Manca URL grafica)`);
            }
          }
        } else {
          skippedItems.push(`${item.title} (Mancano Width/Height nel Catalogo)`);
        }
        }
      }

      if (itemsToPack.length > 0) {
        const { generatePodPdf } = await import("../lib/pod.server");
        const pdfBuffer = await generatePodPdf(itemsToPack);
        
        // AUTO-MARK AS PRINTED
        for (const id of selectedIds) {
          await admin.graphql(
            `#graphql
            mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id value }
              }
            }`,
            {
              variables: {
                metafields: [
                  {
                    ownerId: id,
                    namespace: "pod",
                    key: "printed",
                    value: "true",
                    type: "boolean"
                  }
                ]
              }
            }
          );
        }

        return json({ 
          success: true, 
          pdfBase64: pdfBuffer.toString("base64"),
          fileName: `STAMPA_POD_${new Date().getTime()}.pdf`
        });
      } else {
        const errorMsg = skippedItems.length > 0 
          ? `Impossibile generare il PDF. Motivi: ${skippedItems.join(", ")}`
          : "Nessun articolo valido trovato per la stampa.";
        return json({ error: errorMsg }, { status: 400 });
      }
    } catch (err) {
      console.error("[PDF GEN ERROR]:", err);
      console.error("[PDF GEN STACK]:", err.stack);
      return json({ error: "Errore durante la creazione del PDF: " + err.message }, { status: 500 });
    }
  }

  if (type === "markAsPrinted") {
    const orderIds = JSON.parse(formData.get("orderIds"));
    const value = formData.get("value") || "true";
    console.log(`--- SEGNANDO COME ${value.toUpperCase()}:`, orderIds);
    for (const id of orderIds) {
      const response = await admin.graphql(
        `#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metafields: [
              {
                ownerId: id,
                namespace: "pod",
                key: "printed",
                value: value,
                type: "boolean"
              }
            ]
          }
        }
      );
      const resData = await response.json();
      console.log(`Risultato per ${id}:`, JSON.stringify(resData.data?.metafieldsSet));
    }
    return json({ success: true });
  }

  if (type === "markAsApproved") {
    const orderIds = JSON.parse(formData.get("orderIds"));
    const value = formData.get("value") || "approved";
    for (const id of orderIds) {
      await admin.graphql(
        `#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
          }
        }`,
        {
          variables: {
            metafields: [
              {
                ownerId: id,
                namespace: "pod",
                key: "status",
                value: value,
                type: "single_line_text_field"
              }
            ]
          }
        }
      );
    }
    return json({ success: true });
  }

  if (type === "updateMetafield") {
    const productId = formData.get("productId");
    const key = formData.get("key");
    const value = formData.get("value");

    const response = await admin.graphql(
      `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id value }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: productId,
              namespace: "pod",
              key: key,
              value: value,
              type: "number_decimal"
            }
          ]
        }
      }
    );
    const res = await response.json();
    console.log("Metafield aggiornato:", JSON.stringify(res.data?.metafieldsSet));
    return json(res);
  }


  if (type === "saveEditedImage") {
    const orderId = formData.get("orderId");
    const width = formData.get("width");
    const height = formData.get("height");
    const rawBase64 = formData.get("base64");
    
    if (!rawBase64 || !orderId) {
      return json({ success: false, error: "Dati mancanti per il salvataggio." });
    }

    const isSvg = rawBase64.includes("image/svg+xml");
    const mimeType = isSvg ? "image/svg+xml" : "image/png";
    const extension = isSvg ? "svg" : "png";
    const base64Content = rawBase64.split(",")[1];
    
    try {
      const filename = `edited_${Date.now()}.${extension}`;
      console.log(`[SAVE v1.8.8.2] Formato: ${extension}, Filename: ${filename}`);

      // 1. Staged Upload
      const stagedResponse = await admin.graphql(`#graphql
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
            userErrors { field message }
          }
        }
      `, { variables: { input: [{
        filename: filename,
        mimeType: mimeType,
        resource: "IMAGE"
      }] } });
      
      const stagedResJson = await stagedResponse.json();
      const stagedData = stagedResJson.data?.stagedUploadsCreate;
      if (stagedData?.userErrors?.length > 0) {
        throw new Error("StagedUpload Error: " + stagedData.userErrors[0].message);
      }
      
      const target = stagedData?.stagedTargets?.[0];
      if (!target) throw new Error("Impossibile ottenere target di caricamento da Shopify.");
      
      // 2. Upload
      const uploadForm = new FormData();
      target.parameters.forEach(p => uploadForm.append(p.name, p.value));
      const blob = new Blob([Buffer.from(base64Content, "base64")], { type: mimeType });
      uploadForm.append("file", blob);
      await fetch(target.url, { method: "POST", body: uploadForm });
      
      // 3. File Create
      const fileResponse = await admin.graphql(`#graphql
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files { 
              ... on MediaImage { id image { url } }
              ... on GenericFile { id url }
            }
            userErrors { field message }
          }
        }
      `, { variables: { files: [{
        originalSource: target.resourceUrl,
        contentType: "IMAGE",
        alt: filename
      }] } });
      
      const fileResJson = await fileResponse.json();
      const fileData = fileResJson.data?.fileCreate;
      if (fileData?.userErrors?.length > 0) {
        throw new Error("FileCreate Error: " + fileData.userErrors[0].message);
      }

      let fileId = fileData?.files?.[0]?.id;
      let finalUrl = fileData?.files?.[0]?.image?.url || fileData?.files?.[0]?.url;

      // 4. ULTRA-RESILIENT SCAN (v1.8.9)
      if (!finalUrl) {
         console.log(`[SAVE v1.9.3] Avvio Scansione per ID: ${fileId} e Filename: ${filename}...`);
         for (let i = 0; i < 15; i++) {
            console.log(`[SAVE] Scansione file (tentativo ${i+1}/15)...`);
            await new Promise(resolve => setTimeout(resolve, 6000));
            
            const listResponse = await admin.graphql(`#graphql
              query getRecentFiles {
                files(first: 20, sortKey: CREATED_AT, reverse: true) {
                  nodes {
                    id
                    alt
                    fileErrors { message }
                    ... on MediaImage { status image { url } preview { image { url } } }
                    ... on GenericFile { url }
                  }
                }
              }
            `);
            
            const listJson = await listResponse.json();
            const recentFiles = listJson.data?.files?.nodes || [];
            
            // Cerchiamo il file tramite ID o Alt Text
            const foundFile = recentFiles.find(f => f.id === fileId || f.alt === filename);
            
            if (foundFile) {
               // PRIORITÀ: Preview (solitamente generata istantaneamente) -> Image -> Raw URL
               finalUrl = foundFile.preview?.image?.url || foundFile.image?.url || foundFile.url;
               if (finalUrl) {
                  console.log("[SAVE] URL trovato con Scansione Diretta!");
                  break;
               }
               const errorMsg = foundFile.fileErrors?.[0]?.message || "In elaborazione (CDN latenza)";
               console.warn(`[SAVE] File trovato ma URL assente. Dettaglio: ${errorMsg}`);
            } else {
               console.warn(`[SAVE] Tentativo ${i+1}: File non trovato tra i primi 20 del negozio.`);
            }
         }
      }

      if (!finalUrl) throw new Error(`Latenza Shopify troppo elevata. Controlla nella sezione 'File' di Shopify se vedi un file chiamato '${filename}'. Se sì, riprova tra un minuto.`);


      // 5. Update Metafields
      await admin.graphql(`#graphql
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }`, { 
          variables: { 
            metafields: [
              { ownerId: orderId, namespace: "pod", key: "edited_image", value: finalUrl, type: "single_line_text_field" },
              { ownerId: orderId, namespace: "pod", key: "width", value: width, type: "single_line_text_field" },
              { ownerId: orderId, namespace: "pod", key: "height", value: height, type: "single_line_text_field" }
            ]
          } 
        });

      return json({ success: true, finalUrl });
    } catch (e) {
      console.error("[CRITICAL SAVE ERROR v1.8.9]:", e.message);
      return json({ success: false, error: e.message });
    }
  }

  return json({ error: "Invalid action type" }, { status: 400 });
}


export default function Orders() {
  const { orders, error } = useLoaderData();
  const shopify = useAppBridge();
  const [selectedItems, setSelectedItems] = useState([]);
  const fetcher = useFetcher();
  const editorFetcher = useFetcher();

  const actionData = fetcher.data;
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const [searchValue, setSearchValue] = useState(urlParams.get("query") || "");

  // STATI PER EDIT STUDIO (v1.6.0)
  const [editorOpen, setEditorOpen] = useState(false);
  const [currentEditItem, setCurrentEditItem] = useState(null);
  const [processedImage, setProcessedImage] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [zoomImage, setZoomImage] = useState(null); 
  const [customWidth, setCustomWidth] = useState("80");
  const [customHeight, setCustomHeight] = useState("100");
  const [aspectRatio, setAspectRatio] = useState(1);
  const [isSvg, setIsSvg] = useState(false); // v1.8.0

  const handleOpenEditor = (order, item, imageUrl) => {
    setCurrentEditItem({ orderId: order.id, orderName: order.name, itemId: item.id, imageUrl });
    setProcessedImage(null);
    setStatusMessage("");
    setCustomWidth("80");
    setCustomHeight("100");
    setEditorOpen(true);
  };

  // CALCOLO PROPORZIONI AUTO (v1.7.0)
  useEffect(() => {
    if (processedImage) {
      const img = new window.Image();
      img.onload = () => {
        const ratio = img.width / img.height;
        setAspectRatio(ratio);
        // Default larghezza 80mm
        const w = 80;
        const h = (w / ratio).toFixed(2);
        setCustomWidth(w.toString());
        setCustomHeight(h.toString());
      };
      img.src = processedImage;
    }
  }, [processedImage]);

  const handleWidthChange = (val) => {
    setCustomWidth(val);
    if (!isNaN(parseFloat(val)) && aspectRatio) {
      setCustomHeight((parseFloat(val) / aspectRatio).toFixed(2));
    }
  };

  const handleHeightChange = (val) => {
    setCustomHeight(val);
    if (!isNaN(parseFloat(val)) && aspectRatio) {
      setCustomWidth((parseFloat(val) * aspectRatio).toFixed(2));
    }
  };

  const handleRemoveBackground = () => {
    setIsProcessing(true);
    setStatusMessage("Rimozione sfondo in corso...");
    const formData = new FormData();
    formData.append("type", "removeBackground");
    formData.append("imageUrl", currentEditItem.imageUrl);
    editorFetcher.submit(formData, { method: "POST" });
  };

  const handleConfirmEdit = () => {
    if (!processedImage) return;
    setIsProcessing(true);
    setStatusMessage("Salvataggio grafica pulita...");
    const formData = new FormData();
    formData.append("type", "saveEditedImage");
    formData.append("orderId", currentEditItem.orderId);
    formData.append("base64", processedImage);
    formData.append("width", customWidth);
    formData.append("height", customHeight);
    editorFetcher.submit(formData, { method: "POST" });
  };

  const handleSearchChange = (value) => {
    setSearchValue(value);
    const params = new URLSearchParams(window.location.search);
    if (value) params.set("query", value);
    else params.delete("query");
    navigate(`/app/orders?${params.toString()}`, { replace: true });
  };

  useEffect(() => {
    if (actionData?.success && actionData?.pdfBase64) {
      console.log("PDF PRONTO - Avvio download robusto");
      try {
        const byteCharacters = atob(actionData.pdfBase64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);

        const downloadLink = document.createElement("a");
        downloadLink.href = url;
        let fileName = actionData.fileName || `STAMPA_POD_${new Date().getTime()}.pdf`;
        if (!fileName.toLowerCase().endsWith(".pdf")) {
          fileName += ".pdf";
        }
        downloadLink.download = fileName;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        
        // Pulizia URL per liberare memoria
        setTimeout(() => URL.revokeObjectURL(url), 100);

        window.shopify?.loading(false);
        setSelectedItems([]);
      } catch (e) {
        console.error("Errore download:", e);
        alert("Errore durante la creazione del file PDF nel browser.");
        window.shopify?.loading(false);
      }
    }

  }, [actionData]);
  
  // GESTORE RISPOSTE EDIT STUDIO (v2.2)
  useEffect(() => {
    const data = editorFetcher.data;
    if (data?.success) {
      if (data.base64) {
        setProcessedImage(data.base64);
        setIsProcessing(false);
        setStatusMessage(data.isSvg ? "Vettorializzazione completata! ✅" : "Sfondo rimosso con successo! ✅");
        if (data.isSvg) setIsSvg(true);
      } else if (data.finalUrl) {
        shopify.toast.show("Grafica salvata con successo!");
        setIsProcessing(false);
        setEditorOpen(false);
        setProcessedImage(null);
        setCurrentEditItem(null);
        navigate(".", { replace: true });
      }
    } else if (data?.error) {
      setIsProcessing(false);
      setStatusMessage(`❌ Errore: ${data.error}`);
    }
  }, [editorFetcher.data]);

  const handleGenerate = async () => {
    window.shopify?.loading(true);
    const formData = new FormData();
    formData.append("type", "generatePdf");
    formData.append("orderIds", JSON.stringify(selectedItems));
    fetcher.submit(formData, { method: "POST" });
  };

  const totalPodOrders = (orders || []).length;
  const totalPodItems = (orders || []).reduce((acc, order) => {
    return acc + (order.lineItems?.nodes || []).filter(item => {
      const metafields = item.product?.metafields?.nodes || [];
      const hasSvg = metafields.some(m => m.namespace === "pod" && m.key === "svg" && (m.value || m.reference));
      const hasUrl = metafields.some(m => m.namespace === "custom" && m.key === "pod_svg_url" && m.value);
      return hasSvg || hasUrl;
    }).length;
  }, 0);

  const [sortNewest, setSortNewest] = useState(true);
  const sortedOrders = [...orders].sort((a, b) => {
    const dateA = new Date(a.createdAt).getTime();
    const dateB = new Date(b.createdAt).getTime();
    return sortNewest ? dateB - dateA : dateA - dateB;
  });

  return (
    <Frame>
      <Page title="Ordini Print on Demand">
      <Layout>
        {error && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd" as="h2" tone="critical">🚨 ERRORE DI CARICAMENTO</Text>
                <div style={{ padding: "10px", backgroundColor: "#fff4f4", borderRadius: "4px", border: "1px solid #f8d7da" }}>
                  <Text variant="bodyMd" tone="critical">{error}</Text>
                  <Text variant="bodyXs" tone="subdued">Controlla i log o contatta l'assistenza.</Text>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineStack gap="400" align="start">
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="brand">{totalPodOrders}</Text>
                <Text variant="bodySm" tone="subdued">Ordini POD in lista</Text>
              </div>
            </Card>
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="brand">{totalPodItems}</Text>
                <Text variant="bodySm" tone="subdued">Grafiche totali</Text>
              </div>
            </Card>
            <Card>
              <div style={{ padding: "12px", textAlign: "center" }}>
                <Text variant="headingLg" as="h2" tone="success">
                  {orders.filter(o => o.printed?.value === "true").length}
                </Text>
                <Text variant="bodySm" tone="subdued">Già stampati</Text>
              </div>
            </Card>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" align="center">
                  <Text variant="headingMd" as="h2">Ordini da Elaborare</Text>
                  <Button 
                    variant="plain" 
                    onClick={() => setSortNewest(!sortNewest)}
                  >
                    {sortNewest ? "⇅ Recenti in alto" : "⇅ Vecchi in alto"}
                  </Button>
                </InlineStack>
                <Button 
                  variant="primary" 
                  onClick={handleGenerate} 
                  disabled={selectedItems.length === 0}
                  loading={fetcher.state === "submitting"}
                >
                  Genera PDF per {selectedItems.length} ordini
                </Button>
              </InlineStack>

              {fetcher.data?.error && (
                <Badge tone="critical">{fetcher.data.error}</Badge>
              )}

              <ResourceList
                resourceName={{ singular: "ordine", plural: "ordini" }}
                items={sortedOrders}
                selectedItems={selectedItems}
                onSelectionChange={setSelectedItems}
                selectable
                filterControl={
                  <Filters
                    queryValue={searchValue}
                    filters={[]}
                    onQueryChange={handleSearchChange}
                    onQueryClear={() => handleSearchChange("")}
                    helpText="Cerca per numero ordine (es: 14623)"
                  />
                }
                renderItem={(order) => {
                  const { id, name, createdAt, totalPriceSet, printed, approved, tags } = order;
                  const date = new Date(createdAt).toLocaleDateString();
                  
                  const lineItems = order.lineItems?.nodes || [];
                  const podItems = lineItems.filter(item => {
                    const metafields = [
                      item.product?.pod_width, item.product?.pod_height, item.product?.pod_svg,
                      item.product?.custom_url, item.product?.custom_width, item.product?.custom_height,
                      item.variant?.pod_width, item.variant?.pod_height, item.variant?.pod_svg,
                      item.variant?.custom_url, item.variant?.custom_width, item.variant?.custom_height
                    ].filter(Boolean);
                    const hasSvg = metafields.some(m => m.key === "svg" && (m.value || m.reference));
                    const hasUrl = metafields.some(m => m.key === "pod_svg_url" && m.value);
                    const hasZepto = item.customAttributes?.some(a => ["_pplr_preview", "_pplr_pdf", "_pplr_original"].includes(a.key));
                    return hasSvg || hasUrl || hasZepto;
                  });

                  const totalPrints = podItems.reduce((acc, item) => acc + (item.quantity || 1), 0);
                  const itemsReady = podItems.filter(item => {
                    const metafields = [
                      item.product?.pod_width, item.product?.pod_height, item.product?.pod_svg,
                      item.product?.custom_url, item.product?.custom_width, item.product?.custom_height,
                      item.variant?.pod_width, item.variant?.pod_height, item.variant?.pod_svg,
                      item.variant?.custom_url, item.variant?.custom_width, item.variant?.custom_height
                    ].filter(Boolean);
                    const hasSvg = metafields.some(m => m.key === "svg" && (m.value || m.reference));
                    const hasUrl = metafields.some(m => m.key === "pod_svg_url" && m.value);
                    const hasWidth = metafields.some(m => m.key === "width" && m.value);
                    const hasHeight = metafields.some(m => m.key === "height" && m.value);
                    return (hasSvg || hasUrl) && hasWidth && hasHeight;
                  }).length;

                  const isPrinted = printed?.value === "true";
                  const isApproved = approved?.value === "approved";
                  const allTags = tags || [];
                  const isZepto = allTags.includes("product-personalizer");
                  const needsReview = isZepto && !isApproved;

                  return (
                    <div style={{ 
                      backgroundColor: needsReview ? "#fffcf5" : (isPrinted ? "#f6fbf4" : "transparent"), 
                      borderLeft: needsReview ? "4px solid #d82c0d" : (isPrinted ? "4px solid #458a3c" : "4px solid transparent"),
                      transition: "all 0.3s"
                    }}>
                      <ResourceItem
                        id={id}
                        accessibilityLabel={`Dettagli per ordine ${name}`}
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <div style={{ flex: 1 }}>
                            <BlockStack gap="100">
                              <InlineStack gap="300" blockAlign="center">
                                <Text variant="headingMd" as="h3">
                                  {name}
                                </Text>
                                <InlineStack gap="100">
                                  {isPrinted && <Badge tone="success">Stampato ✅</Badge>}
                                  {isZepto && (
                                    <Badge tone={isApproved ? "info" : "critical"}>
                                      {isApproved ? "ZEPTO: Approvato" : "⚠️ ZEPTO: Da Approvare"}
                                    </Badge>
                                  )}
                                </InlineStack>
                              </InlineStack>

                              <Text variant="bodySm" tone="subdued">
                                {date} • {totalPriceSet?.shopMoney?.amount || "0.00"} {totalPriceSet?.shopMoney?.currencyCode || ""}
                              </Text>

                              <div style={{ padding: "8px 0" }}>
                                <InlineStack gap="400" blockAlign="center">
                                  <Badge tone={itemsReady === podItems.length ? "success" : "warning"}>
                                    {totalPrints} {totalPrints === 1 ? 'stampa' : 'stampe'} effettive
                                  </Badge>
                                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                    {podItems.map((pi, idx) => (
                                      <Text key={pi.id} variant="bodyXs" tone="subdued">
                                        • {pi.title} <strong>(x{pi.quantity})</strong>
                                      </Text>
                                    ))}
                                  </div>
                                </InlineStack>
                              </div>
                              
                              {isZepto && (
                                <div style={{ 
                                  marginTop: "4px", 
                                  padding: "8px 12px", 
                                  backgroundColor: "#f1f2f3", 
                                  borderRadius: "6px",
                                  border: "1px solid #e1e2e3"
                                }}>
                                  <BlockStack gap="100">
                                    <InlineStack gap="100" blockAlign="center">
                                      <span style={{ fontSize: "14px" }}>👁️</span>
                                      <Text variant="bodyXs" fontWeight="bold">DETTAGLI PERSONALIZZAZIONE:</Text>
                                    </InlineStack>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
                                      {podItems.flatMap(li => li.customAttributes || []).map((attr, idx) => (
                                        <div key={idx} style={{ fontSize: "11px", color: "#444" }}>
                                          <span style={{ color: "#888" }}>{attr.key}:</span> <strong>{attr.value}</strong>
                                        </div>
                                      ))}
                                      {podItems.every(li => !li.customAttributes?.length) && (
                                        <Text variant="bodyXs" tone="subdued">Nessun attributo personalizzato trovato.</Text>
                                      )}
                                    </div>
                                  </BlockStack>
                                </div>
                              )}
                            </BlockStack>
                          </div>
                          
                          <div style={{ marginLeft: "20px" }}>
                            <BlockStack gap="200" align="end">
                              {podItems.some(i => i.customAttributes?.some(a => ["Immagine", "Grafica", "_pplr_preview"].includes(a.key))) && (
                                <Button 
                                  onClick={() => {
                                    const itemWithImg = podItems.find(i => i.customAttributes?.some(a => ["Immagine", "Grafica", "_pplr_preview"].includes(a.key)));
                                    const attr = itemWithImg?.customAttributes?.find(a => ["Immagine", "Grafica", "_pplr_preview"].includes(a.key));
                                    if (attr?.value) {
                                      handleOpenEditor(order, itemWithImg, attr.value);
                                    } else {
                                      shopify.toast.show("Impossibile trovare l'URL dell'immagine");
                                    }
                                  }}
                                  icon="edit"
                                  size="slim"
                                >
                                  🎨 Modifica Foto
                                </Button>
                              )}
                              {isZepto && (
                                <Button 
                                  variant="primary"
                                  tone={isApproved ? "success" : "critical"}
                                  onClick={() => {
                                    const formData = new FormData();
                                    formData.append("type", "markAsApproved");
                                    formData.append("orderIds", JSON.stringify([id]));
                                    formData.append("value", isApproved ? "pending" : "approved");
                                    fetcher.submit(formData, { method: "POST" });
                                  }}
                                >
                                  {isApproved ? "Reset Approvaz." : "Approva"}
                                </Button>
                              )}
                              <Button 
                                variant={isPrinted ? "plain" : "secondary"}
                                onClick={() => {
                                  const formData = new FormData();
                                  formData.append("type", "markAsPrinted");
                                  formData.append("orderIds", JSON.stringify([id]));
                                  formData.append("value", isPrinted ? "false" : "true");
                                  fetcher.submit(formData, { method: "POST" });
                                }}
                              >
                                {isPrinted ? "Segna da stampare" : "Segna stampato"}
                              </Button>
                            </BlockStack>
                          </div>
                        </InlineStack>
                      </ResourceItem>
                    </div>
                  );
                }}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={`Edit Studio - ${currentEditItem?.orderName || ""}`}
        primaryAction={{
          content: "Conferma e Salva",
          onAction: handleConfirmEdit,
          disabled: !processedImage || isProcessing,
          loading: isProcessing
        }}
        secondaryActions={[
          {
            content: "Annulla",
            onAction: () => setEditorOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">Originale</Text>
                <Thumbnail
                  source={currentEditItem?.imageUrl || ""}
                  alt="Originale"
                  size="large"
                />
                <div style={{ marginTop: "8px" }}>
                  <Button size="slim" icon="maximize" onClick={() => setZoomImage(currentEditItem?.imageUrl)}>🔍 Zoom</Button>
                </div>
              </BlockStack>
              
              <BlockStack gap="200" align="center">
                <div style={{ paddingTop: "40px" }}>
                  <Text variant="headingLg" as="p">➡️</Text>
                </div>
              </BlockStack>

              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">Senza Sfondo</Text>
                <div style={{ 
                  width: "120px", 
                  height: "120px", 
                  backgroundColor: "#f1f1f1", 
                  borderRadius: "8px", 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "center",
                  border: "1px dashed #ccc"
                }}>
                  {isProcessing ? (
                    <Spinner size="small" />
                  ) : processedImage ? (
                    <img src={processedImage} alt="Processed" style={{ maxWidth: "100%", maxHeight: "100%" }} />
                  ) : (
                    <Text variant="bodyXs" tone="subdued">Premi il tasto sotto</Text>
                  )}
                </div>
                {processedImage && !isProcessing && (
                  <div style={{ marginTop: "8px" }}>
                    <Button size="slim" icon="maximize" onClick={() => setZoomImage(processedImage)}>🔍 Zoom</Button>
                  </div>
                )}
              </BlockStack>
            </InlineStack>

            <Banner tone={processedImage ? "success" : "info"}>
              {statusMessage || "Premi il tasto sotto per rimuovere lo sfondo automaticamente usando Remove.bg"}
            </Banner>

            {processedImage && (
              <Card padding="400">
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h4">📐 Dimensioni Ottimizzate (mm)</Text>
                  <InlineStack gap="400">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Larghezza"
                        type="number"
                        value={customWidth}
                        onChange={handleWidthChange}
                        suffix="mm"
                        autoComplete="off"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Altezza"
                        type="number"
                        value={customHeight}
                        onChange={handleHeightChange}
                        suffix="mm"
                        autoComplete="off"
                      />
                    </div>
                  </InlineStack>
                  <Text variant="bodyXs" tone="subdued">Le dimensioni sono collegate proporzionalmente per evitare deformazioni.</Text>
                </BlockStack>
              </Card>
            )}

            <InlineStack gap="300" align="center">
              <Button 
                onClick={handleRemoveBackground} 
                loading={isProcessing} 
                disabled={isProcessing || !!processedImage}
                variant="secondary"
              >
                ✨ Rimuovi Sfondo
              </Button>
              <Button 
                onClick={() => {
                  setIsProcessing(true);
                  setStatusMessage("Vettorializzazione in corso...");
                  const formData = new FormData();
                  formData.append("type", "vectorizeImage");
                  // Se abbiamo già l'immagine senza sfondo, vettorializziamo quella
                  formData.append("imageUrl", processedImage || currentEditItem.imageUrl);
                  editorFetcher.submit(formData, { method: "POST" });
                }} 
                loading={isProcessing} 
                disabled={isProcessing || isSvg}
                variant="primary"
              >
                📐 Vettorializza (SVG)
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* MODAL ZOOM (v1.6.7) */}
      <Modal
        open={!!zoomImage}
        onClose={() => setZoomImage(null)}
        title="Anteprima Ingrandita"
      >
        <Modal.Section>
          <div style={{ 
            display: "flex", 
            justifyContent: "center", 
            padding: "20px", 
            backgroundColor: "#202123", 
            borderRadius: "12px",
            minHeight: "400px",
            alignItems: "center"
          }}>
            <img 
              src={zoomImage} 
              alt="Zoom" 
              style={{ 
                maxWidth: "100%", 
                maxHeight: "70vh", 
                objectFit: "contain",
                boxShadow: "0 10px 30px rgba(0,0,0,0.5)" 
              }} 
            />
          </div>
        </Modal.Section>
      </Modal>
    </Page>
  </Frame>
  );
}
