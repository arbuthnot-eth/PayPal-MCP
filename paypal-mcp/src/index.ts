/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from 'cloudflare:workers'
import { ProxyToSelf } from 'workers-mcp'

/**
 * Configuration interface for PayPal API credentials and mode
 */
interface PayPalConfig {
  mode: 'sandbox' | 'live'
  clientId: string
  clientSecret: string
}

/**
 * Interface for PayPal OAuth access token response
 */
interface PayPalAccessToken {
  access_token: string
  token_type: string
  expires_in: number
}

/**
 * Interface for PayPal payment order request
 */
interface PayPalPayment {
  intent: 'CAPTURE' | 'AUTHORIZE'
  purchase_units: Array<{
    amount: {
      currency_code: string
      value: string
    }
    description?: string
  }>
  application_context?: {
    return_url: string
    cancel_url: string
    user_action?: string
  }
}

interface CreatePaymentParams {
  amount: string
  currency?: string
  description?: string
  return_url?: string
  cancel_url?: string
}

interface CapturePaymentParams {
  orderId: string
}

/**
 * Interface for PayPal refund request
 */
interface PayPalRefundRequest {
  amount?: {
    currency_code: string
    value: string
  }
  invoice_id?: string
  note_to_payer?: string
}

/**
 * Environment variables interface for the Worker
 */
export interface Env {
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  PAYPAL_MODE: 'sandbox' | 'live'
  SHARED_SECRET: string
}

/**
 * Main Worker class handling PayPal payment operations
 */
export default class MyWorker extends WorkerEntrypoint<Env> {
  private paypalConfig: PayPalConfig | null = null

  private corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }

  private jsonResponse(data: any, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...this.corsHeaders,
      },
    })
  }

  /**
   * Retrieves PayPal configuration from environment variables
   * @returns {Promise<PayPalConfig>} PayPal configuration object
   * @private
   */
  private async getPayPalConfig(): Promise<PayPalConfig> {
    if (!this.paypalConfig) {
      this.paypalConfig = {
        mode: this.env.PAYPAL_MODE || 'sandbox',
        clientId: this.env.PAYPAL_CLIENT_ID,
        clientSecret: this.env.PAYPAL_CLIENT_SECRET
      }
    }
    return this.paypalConfig
  }

  /**
   * Gets an OAuth access token from PayPal API
   * @returns {Promise<string>} PayPal access token
   * @private
   */
  private async getAccessToken(): Promise<string> {
    const config = await this.getPayPalConfig()
    const credentials = btoa(`${config.clientId}:${config.clientSecret}`)
    
    const response = await fetch(`https://api${config.mode === 'sandbox' ? '.sandbox' : ''}.paypal.com/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    })

    if (!response.ok) {
      throw new Error('Failed to get PayPal access token')
    }

    const data: PayPalAccessToken = await response.json()
    return data.access_token
  }

  /**
   * Creates a new PayPal payment order
   * @param {string} amount - The payment amount (e.g. "10.00")
   * @param {string} [currency="USD"] - The currency code (e.g. "USD")
   * @param {string} [description] - Optional description of the payment
   * @returns {Promise<any>} The created payment order details including approval links
   */
  async createPaypalOrder(amount: string, currency: string = 'USD', description?: string): Promise<any> {
    try {
      const accessToken = await this.getAccessToken()
      const config = await this.getPayPalConfig()

      const payment: PayPalPayment = {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: currency,
            value: amount
          },
          description: description
        }],
        application_context: {
          return_url: 'https://paypal-mcp.imbibed.workers.dev/success',
          cancel_url: 'https://paypal-mcp.imbibed.workers.dev/cancel',
          user_action: 'PAY_NOW'
        }
      }

      const response = await fetch(`https://api${config.mode === 'sandbox' ? '.sandbox' : ''}.paypal.com/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payment)
      })

      const result = await response.json()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: response.ok,
            data: result
          })
        }]
      }
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Failed to create PayPal payment: ${error.message}`
          })
        }]
      }
    }
  }

  /**
   * Captures (completes) a PayPal payment order
   * @param {string} orderId - The PayPal order ID to capture
   * @returns {Promise<any>} The capture details including payment status and amount
   */
  async capturePaypalOrder(orderId: string): Promise<any> {
    try {
      const accessToken = await this.getAccessToken()
      const config = await this.getPayPalConfig()

      const response = await fetch(`https://api${config.mode === 'sandbox' ? '.sandbox' : ''}.paypal.com/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      })

      const result = await response.json()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: response.ok,
            data: result
          })
        }]
      }
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Failed to capture PayPal payment: ${error.message}`
          })
        }]
      }
    }
  }

  /**
   * Refunds a captured payment
   * @param {string} captureId - The PayPal-generated ID for the captured payment to refund
   * @param {string} [amount] - Optional amount to refund. If not specified, refunds the full amount
   * @param {string} [currency] - Currency code for the refund amount (e.g. 'USD'). Required if amount is specified
   * @param {string} [note] - Optional note to the payer about the refund
   * @returns {Promise<any>} The refund details including status and amount
   */
  async refundPaypalCapture(captureId: string, amount?: string, currency: string = 'USD', note?: string): Promise<any> {
    try {
      const accessToken = await this.getAccessToken()
      const config = await this.getPayPalConfig()

      const refundRequest: PayPalRefundRequest = {}
      
      if (amount) {
        refundRequest.amount = {
          currency_code: currency,
          value: amount
        }
      }

      if (note) {
        refundRequest.note_to_payer = note
      }

      const response = await fetch(`https://api${config.mode === 'sandbox' ? '.sandbox' : ''}.paypal.com/v2/payments/captures/${captureId}/refund`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(refundRequest)
      })

      const result = await response.json()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: response.ok,
            data: result
          })
        }]
      }
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Failed to process refund: ${error.message}`
          })
        }]
      }
    }
  }

  /**
   * Gets details of a PayPal order
   * @param {string} orderId - The PayPal order ID to check
   * @returns {Promise<any>} The order details including status and payment info
   */
  async getPaypalOrder(orderId: string): Promise<any> {
    try {
      const accessToken = await this.getAccessToken()
      const config = await this.getPayPalConfig()

      const response = await fetch(`https://api${config.mode === 'sandbox' ? '.sandbox' : ''}.paypal.com/v2/checkout/orders/${orderId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      })

      const result = await response.json()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: response.ok,
            data: result
          })
        }]
      }
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Failed to get order details: ${error.message}`
          })
        }]
      }
    }
  }

  /**
   * Handles incoming HTTP requests
   * @param {Request} request - The incoming HTTP request
   * @returns {Promise<Response>} The HTTP response
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    
    // Handle success route for payment completion
    if (url.pathname === '/success') {
      const token = url.searchParams.get('token')
      
      if (!token) {
        return new Response(JSON.stringify({ error: 'Missing token parameter' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...this.corsHeaders,
          }
        })
      }

      try {
        // Capture the payment using the order ID (token)
        const captureResult = await this.capturePaypalOrder(token)
        const resultData = JSON.parse(captureResult.content[0].text)
        
        const htmlResponse = resultData.success 
          ? `<html>
              <head>
                <title>Payment Successful</title>
                <style>
                  body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; text-align: center; }
                  .success { color: #28a745; font-size: 24px; margin-bottom: 20px; }
                  .details { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: left; }
                </style>
              </head>
              <body>
                <h1 class="success">Payment Successful!</h1>
                <div class="details">
                  <p>Order ID: ${token}</p>
                  <p>Status: ${resultData.data.status}</p>
                  <p>Amount: $${resultData.data.purchase_units[0].payments.captures[0].amount.value} ${resultData.data.purchase_units[0].payments.captures[0].amount.currency_code}</p>
                </div>
              </body>
            </html>`
          : `<html>
              <head>
                <title>Payment Error</title>
                <style>
                  body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; text-align: center; }
                  .error { color: #dc3545; font-size: 24px; margin-bottom: 20px; }
                </style>
              </head>
              <body>
                <h1 class="error">Payment Error</h1>
                <p>${resultData.error || 'An error occurred processing the payment.'}</p>
              </body>
            </html>`

        return new Response(htmlResponse, {
          headers: {
            'Content-Type': 'text/html',
            ...this.corsHeaders,
          }
        })
      } catch (error: any) {
        return new Response(`
          <html>
            <head>
              <title>Payment Error</title>
              <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; text-align: center; }
                .error { color: #dc3545; font-size: 24px; margin-bottom: 20px; }
              </style>
            </head>
            <body>
              <h1 class="error">Payment Error</h1>
              <p>${error.message}</p>
            </body>
          </html>
        `, {
          status: 500,
          headers: {
            'Content-Type': 'text/html',
            ...this.corsHeaders,
          }
        })
      }
    }

    // Handle all other routes through ProxyToSelf
    return new ProxyToSelf(this).fetch(request)
  }
}
