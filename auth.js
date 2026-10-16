/* Lot Outline auth (Supabase). Shared by login.html and index.html.
   The publishable key is designed to be public; row-level security protects the data. */
window.LO = (() => {
  const SUPABASE_URL = 'https://vuodmczixoplpmpypcmj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_kDVdnEo5755a2qn6smCr7A_R2bQY6To';
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const here = location.origin + location.pathname.replace(/[^/]*$/, '');
  return {
    sb,
    home: here + 'app.html',
    loginUrl: here + 'login.html',
    async session(){ const { data } = await sb.auth.getSession(); return data.session; },
    async requireLogin(){ const s = await this.session(); if(!s){ location.replace(this.loginUrl); return null; } return s; },
    async profile(){ const s = await this.session(); if(!s) return null; const { data } = await sb.from('profiles').select('*').eq('id', s.user.id).single(); return data; },
    async signOut(){ await sb.auth.signOut(); location.replace(this.loginUrl); },
    GOOGLE_CLIENT_ID: '1089542261991-j5kd0lk14p2oc13e6b5rvn0rjqiaqr7f.apps.googleusercontent.com',
    // Google sign-in runs on our own page (Google Identity Services), so the consent
    // screen names lotoutline.com, not the Supabase project URL. Supabase only verifies the ID token.
    google(){ return sb.auth.signInWithOAuth({ provider:'google', options:{ redirectTo:this.home } }); },
    // Render Google's own sign-in button into each host element; falls back to google() if GIS failed to load.
    googleButtons(hosts, onError){
      if (!window.google?.accounts?.id) {
        hosts.forEach(h => { h.innerHTML = '<button class="btn" type="button">Continue with Google</button>'; h.firstChild.onclick = () => this.google(); });
        return;
      }
      google.accounts.id.initialize({
        client_id: this.GOOGLE_CLIENT_ID,
        ux_mode: 'popup',
        callback: async ({ credential }) => {
          const { error } = await sb.auth.signInWithIdToken({ provider:'google', token: credential });
          if (error) { onError?.(error); return; }
          location.replace(this.home);
        }
      });
      hosts.forEach(h => google.accounts.id.renderButton(h, {
        type:'standard', theme:'outline', size:'large', shape:'pill', text:'continue_with', logo_alignment:'left', width: h.clientWidth || 360
      }));
    },
    apple(){ return sb.auth.signInWithOAuth({ provider:'apple', options:{ redirectTo:this.home } }); },
    magicLink(email){ return sb.auth.signInWithOtp({ email, options:{ emailRedirectTo:this.home } }); },
    signIn(email,password){ return sb.auth.signInWithPassword({ email, password }); },
    signUp(email,password,full_name){ return sb.auth.signUp({ email, password, options:{ data:{ full_name }, emailRedirectTo:this.home } }); },
    reset(email){ return sb.auth.resetPasswordForEmail(email, { redirectTo: here + 'login.html?reset=1' }); },
    updatePassword(password){ return sb.auth.updateUser({ password }); }
  };
})();
