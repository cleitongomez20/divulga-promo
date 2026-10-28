export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          action: string
          created_at: string
          details: Json
          id: string
          result: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json
          id?: string
          result: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json
          id?: string
          result?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bio_links: {
        Row: {
          bio_page_id: string
          created_at: string
          id: string
          position: number
          post_id: string
          product_id: string
          updated_at: string
          user_id: string
          visible: boolean
        }
        Insert: {
          bio_page_id: string
          created_at?: string
          id?: string
          position?: number
          post_id: string
          product_id: string
          updated_at?: string
          user_id: string
          visible?: boolean
        }
        Update: {
          bio_page_id?: string
          created_at?: string
          id?: string
          position?: number
          post_id?: string
          product_id?: string
          updated_at?: string
          user_id?: string
          visible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "bio_links_bio_page_id_user_id_fkey"
            columns: ["bio_page_id", "user_id"]
            isOneToOne: false
            referencedRelation: "bio_pages"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "bio_links_post_id_user_id_fkey"
            columns: ["post_id", "user_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "bio_links_product_id_user_id_fkey"
            columns: ["product_id", "user_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      bio_pages: {
        Row: {
          created_at: string
          id: string
          instagram_account_id: string
          slug: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          instagram_account_id: string
          slug: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          instagram_account_id?: string
          slug?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bio_pages_instagram_account_id_user_id_fkey"
            columns: ["instagram_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "instagram_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      click_events: {
        Row: {
          bio_link_id: string
          created_at: string
          id: string
          is_bot: boolean
          post_id: string
          updated_at: string
          user_agent_hash: string | null
          user_id: string
        }
        Insert: {
          bio_link_id: string
          created_at?: string
          id?: string
          is_bot?: boolean
          post_id: string
          updated_at?: string
          user_agent_hash?: string | null
          user_id: string
        }
        Update: {
          bio_link_id?: string
          created_at?: string
          id?: string
          is_bot?: boolean
          post_id?: string
          updated_at?: string
          user_agent_hash?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "click_events_bio_link_id_user_id_fkey"
            columns: ["bio_link_id", "user_id"]
            isOneToOne: false
            referencedRelation: "bio_links"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "click_events_post_id_user_id_fkey"
            columns: ["post_id", "user_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      comment_events: {
        Row: {
          author_id: string | null
          comment_id: string
          created_at: string
          id: string
          post_id: string
          sent_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          author_id?: string | null
          comment_id: string
          created_at?: string
          id?: string
          post_id: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          author_id?: string | null
          comment_id?: string
          created_at?: string
          id?: string
          post_id?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_events_post_id_user_id_fkey"
            columns: ["post_id", "user_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      connector_runtime: {
        Row: {
          created_at: string
          interval_ms: number
          next_allowed_at: string
          scope: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          interval_ms?: number
          next_allowed_at?: string
          scope: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          interval_ms?: number
          next_allowed_at?: string
          scope?: string
          updated_at?: string
        }
        Relationships: []
      }
      connector_secrets: {
        Row: {
          ciphertext: string
          created_at: string
          id: string
          key_version: number
          updated_at: string
          user_id: string
        }
        Insert: {
          ciphertext: string
          created_at?: string
          id?: string
          key_version?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          ciphertext?: string
          created_at?: string
          id?: string
          key_version?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      entitlements: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
          user_id: string
          value?: Json
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: []
      }
      instagram_accounts: {
        Row: {
          created_at: string
          credential_id: string | null
          daily_limit: number
          id: string
          ig_user_id: string | null
          page_id: string | null
          status: string
          timezone: string
          token_expires_at: string | null
          updated_at: string
          user_id: string
          username: string | null
          warmup_started_at: string | null
        }
        Insert: {
          created_at?: string
          credential_id?: string | null
          daily_limit?: number
          id?: string
          ig_user_id?: string | null
          page_id?: string | null
          status?: string
          timezone?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
          username?: string | null
          warmup_started_at?: string | null
        }
        Update: {
          created_at?: string
          credential_id?: string | null
          daily_limit?: number
          id?: string
          ig_user_id?: string | null
          page_id?: string | null
          status?: string
          timezone?: string
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
          username?: string | null
          warmup_started_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "instagram_accounts_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "connector_secrets"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_connections: {
        Row: {
          created_at: string
          credential_id: string | null
          id: string
          last_synced_at: string | null
          marketplace: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credential_id?: string | null
          id?: string
          last_synced_at?: string | null
          marketplace?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credential_id?: string | null
          id?: string
          last_synced_at?: string | null
          marketplace?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_connections_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "connector_secrets"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_daily: {
        Row: {
          clicks: number
          completed_commission: number
          created_at: string
          day: string
          id: string
          orders: number
          pending_commission: number
          post_id: string | null
          product_id: string | null
          reach: number | null
          template: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          clicks?: number
          completed_commission?: number
          created_at?: string
          day: string
          id?: string
          orders?: number
          pending_commission?: number
          post_id?: string | null
          product_id?: string | null
          reach?: number | null
          template?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          clicks?: number
          completed_commission?: number
          created_at?: string
          day?: string
          id?: string
          orders?: number
          pending_commission?: number
          post_id?: string | null
          product_id?: string | null
          reach?: number | null
          template?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "metrics_daily_post_id_user_id_fkey"
            columns: ["post_id", "user_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "metrics_daily_product_id_user_id_fkey"
            columns: ["product_id", "user_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      orders: {
        Row: {
          commission: number
          created_at: string
          external_order_id: string
          id: string
          ordered_at: string | null
          post_id: string | null
          product_id: string | null
          status: string
          sub_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          commission?: number
          created_at?: string
          external_order_id: string
          id?: string
          ordered_at?: string | null
          post_id?: string | null
          product_id?: string | null
          status?: string
          sub_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          commission?: number
          created_at?: string
          external_order_id?: string
          id?: string
          ordered_at?: string | null
          post_id?: string | null
          product_id?: string | null
          status?: string
          sub_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_post_id_user_id_fkey"
            columns: ["post_id", "user_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "orders_product_id_user_id_fkey"
            columns: ["product_id", "user_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      plans: {
        Row: {
          created_at: string
          id: string
          limits: Json
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          limits?: Json
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          limits?: Json
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      posts: {
        Row: {
          affiliate_link: string | null
          attempts: number
          caption: string | null
          created_at: string
          error: string | null
          format: string
          id: string
          idempotency_key: string
          ig_media_id: string | null
          instagram_account_id: string
          parent_post_id: string | null
          product_id: string
          published_at: string | null
          scheduled_at: string | null
          search_profile_id: string | null
          status: string
          sub_id: string | null
          trigger_word: string | null
          updated_at: string
          user_id: string
          video_asset_id: string | null
        }
        Insert: {
          affiliate_link?: string | null
          attempts?: number
          caption?: string | null
          created_at?: string
          error?: string | null
          format?: string
          id?: string
          idempotency_key?: string
          ig_media_id?: string | null
          instagram_account_id: string
          parent_post_id?: string | null
          product_id: string
          published_at?: string | null
          scheduled_at?: string | null
          search_profile_id?: string | null
          status?: string
          sub_id?: string | null
          trigger_word?: string | null
          updated_at?: string
          user_id: string
          video_asset_id?: string | null
        }
        Update: {
          affiliate_link?: string | null
          attempts?: number
          caption?: string | null
          created_at?: string
          error?: string | null
          format?: string
          id?: string
          idempotency_key?: string
          ig_media_id?: string | null
          instagram_account_id?: string
          parent_post_id?: string | null
          product_id?: string
          published_at?: string | null
          scheduled_at?: string | null
          search_profile_id?: string | null
          status?: string
          sub_id?: string | null
          trigger_word?: string | null
          updated_at?: string
          user_id?: string
          video_asset_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "posts_instagram_account_id_user_id_fkey"
            columns: ["instagram_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "instagram_accounts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "posts_parent_post_id_user_id_fkey"
            columns: ["parent_post_id", "user_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "posts_product_id_user_id_fkey"
            columns: ["product_id", "user_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "posts_search_profile_id_user_id_fkey"
            columns: ["search_profile_id", "user_id"]
            isOneToOne: false
            referencedRelation: "search_profiles"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "posts_video_asset_id_user_id_fkey"
            columns: ["video_asset_id", "user_id"]
            isOneToOne: false
            referencedRelation: "video_assets"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      products: {
        Row: {
          category: string | null
          click_score: number | null
          collected_at: string
          commission: number | null
          created_at: string
          external_id: string
          id: string
          images: Json
          marketplace: string
          price: number | null
          rating: number | null
          sales: number | null
          title: string
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          category?: string | null
          click_score?: number | null
          collected_at?: string
          commission?: number | null
          created_at?: string
          external_id: string
          id?: string
          images?: Json
          marketplace?: string
          price?: number | null
          rating?: number | null
          sales?: number | null
          title: string
          updated_at?: string
          url?: string | null
          user_id: string
        }
        Update: {
          category?: string | null
          click_score?: number | null
          collected_at?: string
          commission?: number | null
          created_at?: string
          external_id?: string
          id?: string
          images?: Json
          marketplace?: string
          price?: number | null
          rating?: number | null
          sales?: number | null
          title?: string
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          name: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id: string
          name?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      search_profiles: {
        Row: {
          created_at: string
          filters: Json
          id: string
          instagram_account_id: string | null
          mode: string
          name: string
          posts_per_day: number
          updated_at: string
          user_id: string
          windows: Json
        }
        Insert: {
          created_at?: string
          filters?: Json
          id?: string
          instagram_account_id?: string | null
          mode?: string
          name: string
          posts_per_day?: number
          updated_at?: string
          user_id: string
          windows?: Json
        }
        Update: {
          created_at?: string
          filters?: Json
          id?: string
          instagram_account_id?: string | null
          mode?: string
          name?: string
          posts_per_day?: number
          updated_at?: string
          user_id?: string
          windows?: Json
        }
        Relationships: [
          {
            foreignKeyName: "search_profiles_instagram_account_id_user_id_fkey"
            columns: ["instagram_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "instagram_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      settings: {
        Row: {
          created_at: string
          daily_post_limit: number
          id: string
          max_attempts: number
          min_images: number
          min_interval_minutes: number
          products_per_day: number
          repeat_days: number
          story_delay_max_hours: number
          story_delay_min_hours: number
          timezone: string
          updated_at: string
          user_id: string
          warmup_initial_days: number
          warmup_initial_limit: number
          warmup_second_end_day: number
          warmup_second_limit: number
          window_end: string
          window_start: string
        }
        Insert: {
          created_at?: string
          daily_post_limit?: number
          id?: string
          max_attempts?: number
          min_images?: number
          min_interval_minutes?: number
          products_per_day?: number
          repeat_days?: number
          story_delay_max_hours?: number
          story_delay_min_hours?: number
          timezone?: string
          updated_at?: string
          user_id: string
          warmup_initial_days?: number
          warmup_initial_limit?: number
          warmup_second_end_day?: number
          warmup_second_limit?: number
          window_end?: string
          window_start?: string
        }
        Update: {
          created_at?: string
          daily_post_limit?: number
          id?: string
          max_attempts?: number
          min_images?: number
          min_interval_minutes?: number
          products_per_day?: number
          repeat_days?: number
          story_delay_max_hours?: number
          story_delay_min_hours?: number
          timezone?: string
          updated_at?: string
          user_id?: string
          warmup_initial_days?: number
          warmup_initial_limit?: number
          warmup_second_end_day?: number
          warmup_second_limit?: number
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          created_at: string
          external_id: string | null
          id: string
          plan_id: string | null
          provider: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          external_id?: string | null
          id?: string
          plan_id?: string | null
          provider?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          external_id?: string | null
          id?: string
          plan_id?: string | null
          provider?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      video_assets: {
        Row: {
          created_at: string
          duration_seconds: number | null
          id: string
          instagram_account_id: string | null
          provider_job_id: string | null
          storage_path: string | null
          template: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          duration_seconds?: number | null
          id?: string
          instagram_account_id?: string | null
          provider_job_id?: string | null
          storage_path?: string | null
          template?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          duration_seconds?: number | null
          id?: string
          instagram_account_id?: string | null
          provider_job_id?: string | null
          storage_path?: string | null
          template?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_assets_instagram_account_id_user_id_fkey"
            columns: ["instagram_account_id", "user_id"]
            isOneToOne: false
            referencedRelation: "instagram_accounts"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      private_access: { Args: never; Returns: boolean }
      record_foundation_access: { Args: never; Returns: undefined }
      reserve_connector_slot: {
        Args: { p_interval_ms?: number; p_scope: string }
        Returns: number
      }
      save_foundation_settings: { Args: { payload: Json }; Returns: undefined }
      shopee_record_test: {
        Args: {
          p_credential_id: string
          p_details: Json
          p_result: string
          p_status: string
          p_user_id: string
        }
        Returns: undefined
      }
      shopee_remove_credentials: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      shopee_store_credentials: {
        Args: { p_ciphertext: string; p_user_id: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
