/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from 'cloudflare:workers'
import { ProxyToSelf } from 'workers-mcp'

interface PayPalConfig {
  mode: 'sandbox' | 'live'
  clientId: string
  clientSecret: string
}

interface PayPalAccessToken {
  access_token: string
  token_type: string
  expires_in: number
}

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

export interface Env {
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  PAYPAL_MODE: 'sandbox' | 'live'
  SHARED_SECRET: string
}

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
   * Create a PayPal payment order
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
   * Capture a PayPal payment order
   * @param {string} orderId - The PayPal order ID to capture
   * @returns {Promise<any>} The capture details
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
   * @ignore
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    
    // Handle success route
    if (url.pathname === '/success') {
      const token = url.searchParams.get('token')
      const PayerID = url.searchParams.get('PayerID')
      
      if (!token) {
        return this.jsonResponse({ error: 'Missing token parameter' }, 400)
      }

      try {
        // Capture the payment using the order ID (token)
        const captureResult = await this.capturePaypalOrder(token)
        const resultData = JSON.parse(captureResult.content[0].text)
        
        if (resultData.success) {
          return new Response(`
            <html>
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
            </html>
          `, {
            headers: {
              'Content-Type': 'text/html',
              ...this.corsHeaders,
            }
          })
        } else {
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
                <p>${resultData.error || 'An error occurred processing the payment.'}</p>
              </body>
            </html>
          `, {
            headers: {
              'Content-Type': 'text/html',
              ...this.corsHeaders,
            }
          })
        }
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
